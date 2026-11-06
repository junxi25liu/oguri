import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * The superagents end to end (ADR 0031), across two machines that share only a
 * real bare transport repository.
 *
 * "hq" runs the big superagent. "box" runs a small superagent with its worker
 * engine. The owner talks to the big one; it deploys a worker on box; box runs
 * it as a Claude-style session; the big one tells the owner it is done. The
 * owner's next message is passed to the same worker, which resumes its session.
 * The owner also talks to box's small superagent directly. A model reply that
 * names a machine nobody has is refused, and nothing is started.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
const SESSION = "11111111-2222-3333-4444-555555555555";

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

/** A worker session: records what it was asked and answers like `claude -p --output-format json`. */
const WORKER = `
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
  const resumed = process.argv.includes("--resume");
  console.log(JSON.stringify({
    type: "result",
    session_id: ${JSON.stringify(SESSION)},
    result: resumed ? "Renamed the cancel button too." : "Renamed the save button.",
  }));
});
`;

/**
 * The superagents' model. It reads the prompt like a model would and answers
 * with a decision; the last line of BRAIN_SCRIPT can force a bad answer.
 */
const BRAIN = `
const fs = require("fs");
let prompt = "";
process.stdin.on("data", (d) => (prompt += d)).on("end", () => {
  fs.appendFileSync(process.env.BRAIN_FILE, JSON.stringify({ prompt }) + "\\n");
  const message = prompt.slice(prompt.lastIndexOf("<<<MESSAGE") + 10, prompt.lastIndexOf("MESSAGE>>>"));
  const task = (prompt.match(/^  - ([0-9A-Z]{26}) \\[/m) || [])[1];
  let decision;
  if (/small superagent of machine/.test(prompt) && /two workers/.test(message)) {
    // The small superagent decides how many: two, with no target, so both stay on box.
    decision = { kind: "plan", title: "Two checks", room: "superagent", acknowledgement: "Two workers.",
      reason: "independent", steps: [
        { key: "lint", title: "Lint", body: "Run the linter.", dependsOn: [] },
        { key: "types", title: "Types", body: "Run the type check.", dependsOn: [] },
      ] };
  } else if (/small superagent of machine/.test(prompt)) {
    decision = { kind: "answer", text: "box is up and has no worker waiting on you.", reason: "status" };
  } else if (/Ship it to the moon/.test(message)) {
    decision = { kind: "accept", title: "Moon", room: "superagent", target: "machine:moon", acknowledgement: "OK", reason: "bad" };
  } else if (/Also/.test(message)) {
    decision = { kind: "attach", taskId: task, reason: "refers to the change just made" };
  } else if (/Rename/.test(message)) {
    decision = { kind: "accept", title: "Rename the save button", room: "superagent", target: "box-claude",
      acknowledgement: "On it: renaming the save button.", reason: "explicit request" };
  } else {
    decision = { kind: "ignore", reason: "nothing asked" };
  }
  // Like claude -p --output-format json: the decision is the text of the result.
  console.log(JSON.stringify({ type: "result", result: "\`\`\`json\\n" + JSON.stringify(decision) + "\\n\`\`\`" }));
});
`;

let tmp: string;
let hq: string;
let box: string;
let calls: string;
let brainCalls: string;

async function oguri(home: string, ...args: string[]): Promise<string> {
  const env = testEnv({
    OGURI_HOME: home,
    NO_COLOR: "1",
    CALLS_FILE: calls,
    BRAIN_FILE: brainCalls,
    // Two homes, two machines.
    OGURI_MACHINE_ID: home === hq ? "hq" : "box",
  });
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
  return stdout;
}

const bigPass = () => oguri(hq, "superagent", "start", "--once");
const boxPass = () => oguri(box, "superagent", "start", "--once");

async function lines(
  file: string,
): Promise<{ argv?: string[]; input?: string; prompt?: string }[]> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { argv?: string[]; input?: string; prompt?: string });
}

interface Shown {
  id: string;
  from: string;
  body: string;
  tags: string[];
  inReplyTo?: string;
}

async function conversation(home: string): Promise<Shown[]> {
  const raw = await oguri(home, "read", "superagent", "--json");
  return (JSON.parse(raw) as Shown[]).map((m) => ({
    id: m.id,
    from: m.from,
    body: m.body,
    tags: m.tags,
    ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
  }));
}

function sentId(output: string): string {
  const match = /\(([0-9A-Z]{26})\)/.exec(output);
  assert.ok(match !== null, `no message id in: ${output}`);
  return match[1] as string;
}

function policy(extra: string[]): string {
  const node = JSON.stringify(process.execPath);
  const worker = JSON.stringify(join(tmp, "worker.cjs"));
  const brain = JSON.stringify(join(tmp, "brain.cjs"));
  return [
    "v: 1",
    "worker:",
    "  runners:",
    "    claude:",
    `      argv: [${node}, ${worker}, -p, --output-format, json]`,
    `      resume: [${node}, ${worker}, -p, --output-format, json, --resume, "{session}"]`,
    "      session: claude-json",
    "    brain:",
    `      argv: [${node}, ${brain}]`,
    "  defaultRunner: claude",
    `  workdir: ${JSON.stringify(tmp)}`,
    ...extra,
    "",
  ].join("\n");
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-superagent-"));
  calls = join(tmp, "calls.jsonl");
  brainCalls = join(tmp, "brain.jsonl");
  await writeFile(join(tmp, "worker.cjs"), WORKER);
  await writeFile(join(tmp, "brain.cjs"), BRAIN);
  const remote = join(tmp, "transport.git");
  hq = join(tmp, "hq");
  box = join(tmp, "box");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri(hq, "init", "--repo", remote, "--network", "home", "--agent", "alice-big");
  await oguri(box, "init", "--repo", remote, "--network", "home", "--agent", "box-claude");

  await writeFile(
    join(hq, "policy.yaml"),
    policy([
      "  enabled: false",
      "superagent:",
      "  big:",
      "    enabled: true",
      "    runner: brain",
      "    timeoutSeconds: 30",
    ]),
  );
  await writeFile(
    join(box, "policy.yaml"),
    policy([
      "  enabled: true",
      "superagent:",
      "  small:",
      "    enabled: true",
      "    big: alice-big",
      "    runner: brain",
    ]),
  );
  // First passes create and join the conversation room, and publish both machines.
  await bigPass();
  await boxPass();
  await bigPass();
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the big and small superagents", () => {
  let request: string;

  it("deploys a worker on another machine and tells the owner when it is done", async () => {
    request = sentId(await oguri(box, "big", "Rename the save button to Submit", "--detach"));

    await bigPass();
    let shown = await conversation(hq);
    const deployed = shown.find(
      (m) => m.inReplyTo === request && m.tags.includes("from-superagent"),
    );
    assert.ok(deployed !== undefined, "the big superagent replied");
    assert.match(deployed.body, /On it: renaming the save button\./);
    assert.match(deployed.body, /Worker deployed on box-claude: task [0-9A-Z]{6}\.\n/);
    assert.match(deployed.body, /Follow it with: oguri superagent status/);
    const [brain] = await lines(brainCalls).then((all) => all.slice(-1));
    assert.match(brain?.prompt ?? "", /machine:box/, "the big superagent saw the machines");

    // box's small superagent deploys the worker; the big one's task needs no approval there.
    await boxPass();
    const [first] = await lines(calls);
    assert.ok(first !== undefined, "box ran the worker");
    assert.match(first.input ?? "", /Rename the save button to Submit/);

    await bigPass();
    shown = await conversation(hq);
    const done = shown.filter((m) => m.inReplyTo === request && m.body.startsWith("Done: "));
    assert.equal(done.length, 1, "told once");
    assert.match(done[0]?.body ?? "", /Renamed the save button\./);

    await bigPass();
    shown = await conversation(hq);
    assert.equal(
      shown.filter((m) => m.inReplyTo === request && m.body.startsWith("Done: ")).length,
      1,
      "a later pass tells nothing twice",
    );
  });

  it("passes the owner's next message to the same worker, which resumes its session", async () => {
    const next = sentId(await oguri(box, "big", "Also the cancel button", "--detach"));
    await bigPass();
    const shown = await conversation(hq);
    const passed = shown.find((m) => m.inReplyTo === next);
    assert.match(passed?.body ?? "", /Passed to the worker on .* \(task [0-9A-Z]{6}\)\./);

    await boxPass();
    const all = await lines(calls);
    assert.equal(all.length, 2);
    assert.deepEqual(all[1]?.argv?.slice(-2), ["--resume", SESSION]);
    assert.match(all[1]?.input ?? "", /Also the cancel button/);
  });

  it("answers when the owner talks to a small superagent directly", async () => {
    const asked = sentId(await oguri(hq, "small", "machine:box", "How are you doing?", "--detach"));
    await boxPass();
    const shown = await conversation(box);
    const answer = shown.find((m) => m.inReplyTo === asked);
    assert.equal(answer?.from, "box-claude");
    assert.match(answer?.body ?? "", /box is up/);
    // The big superagent leaves a message for a small one alone.
    await bigPass();
    const after = await conversation(hq);
    assert.equal(after.filter((m) => m.inReplyTo === asked).length, 1);
  });

  it("lets a small superagent decide how many workers to run, in parallel on its machine", async () => {
    const before = (await lines(calls)).length;
    const asked = sentId(
      await oguri(hq, "small", "box-claude", "run two workers: lint and types", "--detach"),
    );
    await boxPass(); // the small superagent decides and deploys
    await boxPass(); // the worker engine runs both
    const shown = await conversation(box);
    const answer = shown.find((m) => m.inReplyTo === asked);
    assert.match(answer?.body ?? "", /2 workers deployed/);
    const ran = (await lines(calls)).slice(before);
    assert.equal(ran.length, 2, "both workers ran");
    assert.match(ran.map((r) => r.input).join("\n"), /Run the linter\./);
    assert.match(ran.map((r) => r.input).join("\n"), /Run the type check\./);
    const prompt = (await lines(brainCalls)).at(-1)?.prompt ?? "";
    assert.match(prompt, /runs up to 3 at once/, "the small superagent was told its capacity");
  });

  it("refuses a decision that names a machine nobody has, and starts nothing", async () => {
    const workersBefore = (await lines(calls)).length;
    const asked = sentId(await oguri(box, "big", "Ship it to the moon", "--detach"));
    await bigPass();
    const shown = await conversation(hq);
    const answer = shown.find((m) => m.inReplyTo === asked);
    assert.match(answer?.body ?? "", /could not decide/);
    assert.match(answer?.body ?? "", /machine:moon/);
    await boxPass();
    assert.equal((await lines(calls)).length, workersBefore, "no worker ran");
  });
});
