import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * A message reaches a worker while it runs (ADR 0032), across two machines
 * that share only a real bare transport repository, as a live superagent steers
 * a running worker's inbox.
 *
 * The big superagent on "hq" deploys a worker on "box", whose runner is a live
 * session (`session: claude-stream`). While its first turn is still running,
 * the owner says more; the big superagent passes it to the worker, and box
 * writes it into the same running process. One process, one session, both
 * messages answered.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
const SESSION = "44444444-5555-6666-7777-888888888888";

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

/** Like `claude -p --input-format stream-json --output-format stream-json`: a slow first turn. */
const STREAMER = `
const fs = require("fs");
fs.appendFileSync(process.env.SPAWNS, "spawn\\n");
let buffer = "";
const queue = [];
let busy = false;
let turns = 0;
let release = null;
const turn = () => {
  if (busy || queue.length === 0) return;
  busy = true;
  const text = queue.shift();
  fs.appendFileSync(process.env.SEEN, text + "\\n---\\n");
  console.log(JSON.stringify({ type: "user", isReplay: true,
    message: { role: "user", content: [{ type: "text", text }] } }));
  turns += 1;
  const first = turns === 1;
  const finish = () => {
    clearTimeout(timer);
    release = null;
    console.log(JSON.stringify({ type: "result", session_id: ${JSON.stringify(SESSION)},
      result: first ? "Renamed the title." : "Renamed the subtitle as well." }));
    busy = false;
    turn();
  };
  // The first turn lasts until the follow-up arrives, so a loaded machine cannot outrun it.
  const timer = setTimeout(finish, first ? 90000 : 200);
  if (first) release = finish;
};
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION)} }));
process.stdin.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (line.trim()) queue.push(JSON.parse(line).message.content[0].text);
  }
  if (release && queue.length > 0) release();
  else turn();
});
`;

/** The big superagent's model: deploy on box, then pass the follow-up to that worker. */
const BRAIN = `
let prompt = "";
process.stdin.on("data", (d) => (prompt += d)).on("end", () => {
  const message = prompt.slice(prompt.lastIndexOf("<<<MESSAGE") + 10, prompt.lastIndexOf("MESSAGE>>>"));
  const task = (prompt.match(/^  - ([0-9A-Z]{26}) \\[/m) || [])[1];
  const decision = /Also/.test(message)
    ? { kind: "attach", taskId: task, reason: "the change just made" }
    : { kind: "accept", title: "Rename the title", room: "superagent", target: "box-claude",
        acknowledgement: "On it.", reason: "asked" };
  console.log(JSON.stringify(decision));
});
`;

let tmp: string;
let hq: string;
let box: string;
let seen: string;
let spawns: string;

async function oguri(home: string, ...args: string[]): Promise<string> {
  const env = testEnv({
    OGURI_HOME: home,
    NO_COLOR: "1",
    SEEN: seen,
    SPAWNS: spawns,
    OGURI_MACHINE_ID: home === hq ? "hq" : "box",
  });
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
  return stdout;
}

const pass = (home: string) => oguri(home, "superagent", "start", "--once");

function sentId(output: string): string {
  const match = /\(([0-9A-Z]{26})\)/.exec(output);
  assert.ok(match !== null, output);
  return match[1] as string;
}

async function replies(to: string): Promise<string[]> {
  const shown = JSON.parse(await oguri(hq, "read", "superagent", "--json")) as {
    inReplyTo: string | null;
    body: string;
  }[];
  return shown.filter((m) => m.inReplyTo === to).map((m) => m.body);
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-superagent-live-"));
  seen = join(tmp, "seen.txt");
  spawns = join(tmp, "spawns.txt");
  await writeFile(join(tmp, "streamer.cjs"), STREAMER);
  await writeFile(join(tmp, "brain.cjs"), BRAIN);
  const remote = join(tmp, "transport.git");
  hq = join(tmp, "hq");
  box = join(tmp, "box");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri(hq, "init", "--repo", remote, "--network", "home", "--agent", "alice-big");
  await oguri(box, "init", "--repo", remote, "--network", "home", "--agent", "box-claude");
  const node = JSON.stringify(process.execPath);
  const streamer = JSON.stringify(join(tmp, "streamer.cjs"));
  const runners = [
    "  runners:",
    "    live:",
    `      argv: [${node}, ${streamer}]`,
    `      resume: [${node}, ${streamer}, --resume, "{session}"]`,
    "      session: claude-stream",
    `    brain: [${node}, ${JSON.stringify(join(tmp, "brain.cjs"))}]`,
    "  defaultRunner: live",
    `  workdir: ${JSON.stringify(tmp)}`,
  ];
  await writeFile(
    join(hq, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      ...runners,
      "superagent:",
      "  big: { enabled: true, runner: brain }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(box, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      ...runners,
      "superagent:",
      "  small: { enabled: true, big: alice-big, talk: false }",
      "",
    ].join("\n"),
  );
  await pass(hq);
  await pass(box);
  await pass(hq);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a live worker session", () => {
  it("takes the owner's next message while it runs, in the same process and session", async () => {
    const asked = sentId(await oguri(hq, "big", "Rename the title", "--detach"));
    await pass(hq); // deploys the worker on box

    const running = pass(box); // box runs it; its first turn is slow
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const next = sentId(await oguri(hq, "big", "Also the subtitle", "--detach"));
    await pass(hq); // passes it to the running worker
    assert.ok((await replies(next)).some((body) => /Passed to the worker/.test(body)));
    await running;

    const spawned = (await readFile(spawns, "utf8")).trim().split("\n");
    assert.equal(spawned.length, 1, "one process took both messages");
    const log = await readFile(seen, "utf8");
    assert.match(log, /Rename the title/);
    assert.match(
      log,
      /---\nA person followed up[\s\S]*Also the subtitle[\s\S]*arrived while you were working/,
    );

    await pass(hq);
    const told = await replies(asked);
    assert.ok(
      told.some(
        (body) => body.startsWith("Done: Rename the title") && /subtitle as well/.test(body),
      ),
      JSON.stringify(told),
    );

    // The message was answered by the live run, so it is not run again as a follow-up.
    await pass(box);
    assert.equal((await readFile(spawns, "utf8")).trim().split("\n").length, 1);
  });
});
