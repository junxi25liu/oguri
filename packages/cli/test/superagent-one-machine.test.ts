import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * One machine, one identity (ADR 0031 §7). The owner, the big superagent, the
 * small superagent, and the worker are all the same agent, as on a laptop set
 * up with `oguri init` once. A worker the big superagent deploys still runs,
 * the owner is still told, and a message passed to the worker still resumes
 * its session, because a worker accepts a person's words relayed by its own
 * identity.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
const SESSION = "22222222-3333-4444-5555-666666666666";

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const WORKER = `
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
  console.log(JSON.stringify({ type: "result", session_id: ${JSON.stringify(SESSION)},
    result: process.argv.includes("--resume") ? "Also done." : "Done the first part." }));
});
`;

const BRAIN = `
let prompt = "";
process.stdin.on("data", (d) => (prompt += d)).on("end", () => {
  const message = prompt.slice(prompt.lastIndexOf("<<<MESSAGE") + 10, prompt.lastIndexOf("MESSAGE>>>"));
  const task = (prompt.match(/^  - ([0-9A-Z]{26}) \\[/m) || [])[1];
  const decision = /Also/.test(message)
    ? { kind: "attach", taskId: task, reason: "same change" }
    : { kind: "accept", title: "First part", room: "superagent", target: "machine:laptop",
        acknowledgement: "On it.", reason: "asked" };
  console.log(JSON.stringify(decision));
});
`;

let tmp: string;
let home: string;
let calls: string;

async function oguri(...args: string[]): Promise<string> {
  const env = testEnv({
    OGURI_HOME: home,
    NO_COLOR: "1",
    CALLS_FILE: calls,
    OGURI_MACHINE_ID: "laptop",
  });
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
  return stdout;
}

/** Every pass's output, so a failure on a slow CI runner explains itself. */
const passLog: string[] = [];

const pass = async (): Promise<string> => {
  const out = await oguri("superagent", "start", "--once");
  passLog.push(`--- pass ${String(passLog.length + 1)}\n${out}`);
  return out;
};

const passes = (): string => passLog.slice(-12).join("\n");

/**
 * Pass until `done` holds. Deploying takes a chain of passes (big decides,
 * small deploys, the worker runs, the report goes up), and a slow CI runner
 * can need more of them than a laptop does; a fixed count made this flaky.
 */
async function passUntil(done: () => Promise<boolean>, max = 10): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    await pass();
    if (await done()) return;
  }
}

function sentId(output: string): string {
  const match = /\(([0-9A-Z]{26})\)/.exec(output);
  assert.ok(match !== null, output);
  return match[1] as string;
}

async function calledWith(): Promise<{ argv: string[]; input: string }[]> {
  const raw = await readFile(calls, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; input: string });
}

async function replies(to: string): Promise<string[]> {
  const shown = JSON.parse(await oguri("read", "superagent", "--json")) as {
    inReplyTo: string | null;
    body: string;
  }[];
  return shown.filter((m) => m.inReplyTo === to).map((m) => m.body);
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-superagent-one-"));
  home = join(tmp, "home");
  calls = join(tmp, "calls.jsonl");
  await writeFile(join(tmp, "worker.cjs"), WORKER);
  await writeFile(join(tmp, "brain.cjs"), BRAIN);
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri("init", "--repo", remote, "--network", "home", "--agent", "liu-claude");
  const node = JSON.stringify(process.execPath);
  const worker = JSON.stringify(join(tmp, "worker.cjs"));
  await writeFile(
    join(home, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  defaultRunner: claude",
      "  runners:",
      "    claude:",
      `      argv: [${node}, ${worker}, -p, --output-format, json]`,
      `      resume: [${node}, ${worker}, -p, --output-format, json, --resume, "{session}"]`,
      "      session: claude-json",
      `    brain: [${node}, ${JSON.stringify(join(tmp, "brain.cjs"))}]`,
      "superagent:",
      "  big: { enabled: true, runner: brain }",
      "  small: { enabled: true }",
      "",
    ].join("\n"),
  );
  await pass();
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the superagents on one machine with one identity", () => {
  it("deploys a worker, tells the owner, and passes the next message to the same session", async () => {
    const asked = sentId(await oguri("big", "Do the first part", "--detach"));
    await passUntil(async () =>
      (await replies(asked)).some((body) => body.startsWith("Done: First part")),
    );
    assert.equal((await calledWith()).length, 1, `the worker ran once\n${passes()}`);
    const told = await replies(asked);
    assert.ok(
      told.some((body) => /Worker deployed on machine:laptop/.test(body)),
      JSON.stringify(told),
    );
    assert.ok(
      told.some((body) => body.startsWith("Done: First part")),
      JSON.stringify(told),
    );

    const next = sentId(await oguri("big", "Also the second part", "--detach"));
    await passUntil(async () => (await calledWith()).length >= 2);
    const all = await calledWith();
    assert.equal(all.length, 2, `the follow-up ran\n${passes()}`);
    assert.deepEqual(all[1]?.argv.slice(-2), ["--resume", SESSION]);
    assert.match(all[1]?.input ?? "", /Also the second part/);
    assert.ok((await replies(next)).some((body) => /Passed to the worker/.test(body)));
  });
});
