import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  OneShotMind,
  ResumeMind,
  SessionStore,
  StreamMind,
  mindFor,
  rulesHash,
  sessionIdOf,
} from "../src/mind.ts";

/**
 * A superagent's standing session (ADR 0033), as a long-lived session should
 * be: the rules once, then one short turn per decision, across restarts.
 */

/** Like `claude -p --output-format json [--resume id]`: logs what it was given. */
const JSON_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const id = at === -1 ? "s-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) : args[at + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d)).on("end", () => {
  fs.appendFileSync(process.env.CALLS, JSON.stringify({ resumed: at !== -1, id, prompt }) + "\\n");
  if (process.env.FAIL_RESUME === "1" && at !== -1) { process.stderr.write("no such session"); process.exit(1); }
  console.log(JSON.stringify({ type: "result", session_id: id, result: JSON.stringify({ kind: "ignore", reason: "turn" }) }));
});
`;

/** Like `claude -p --input-format stream-json --output-format stream-json`, kept up. */
const STREAM_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const id = at === -1 ? "st-" + process.pid : args[at + 1];
fs.appendFileSync(process.env.CALLS, JSON.stringify({ spawn: true, resumed: at !== -1, id }) + "\\n");
let buffer = "";
process.stdin.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const text = JSON.parse(line).message.content[0].text;
    fs.appendFileSync(process.env.CALLS, JSON.stringify({ turn: text.slice(0, 40), pid: process.pid }) + "\\n");
    if (process.env.HANG === "1") continue;
    console.log(JSON.stringify({ type: "result", session_id: id, result: '{"kind":"ignore","reason":"ok"}' }));
  }
});
`;

let tmp: string;
let jsonScript: string;
let streamScript: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-mind-"));
  jsonScript = join(tmp, "json-claude.cjs");
  streamScript = join(tmp, "stream-claude.cjs");
  await writeFile(jsonScript, JSON_CLAUDE);
  await writeFile(streamScript, STREAM_CLAUDE);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function calls(path: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const RULES = "You are the big superagent. RULES-V1";

describe("a resumed session (claude-json)", () => {
  it("gets the rules once, then only turns, and survives a new process", async () => {
    const log = join(tmp, "json-calls.jsonl");
    process.env["CALLS"] = log;
    const runner = {
      name: "brain",
      argv: [process.execPath, jsonScript],
      resume: [process.execPath, jsonScript, "--resume", "{session}"],
      session: "claude-json" as const,
      cwd: tmp,
    };
    const store = new SessionStore(join(tmp, "big-session.json"));
    const first = new ResumeMind(runner, store);
    assert.equal(await first.primed(RULES), false);
    const one = await first.turn({ rules: RULES, turn: "TURN-1", timeoutMs: 10_000 });
    assert.equal(one.ok, true);
    assert.equal(await first.primed(RULES), true);

    // A new oguri process: the same session, from its file.
    const second = new ResumeMind(runner, new SessionStore(join(tmp, "big-session.json")));
    await second.turn({ rules: RULES, turn: "TURN-2", timeoutMs: 10_000 });
    const seen = await calls(log);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.["resumed"], false);
    assert.match(String(seen[0]?.["prompt"]), /RULES-V1[\s\S]*TURN-1/);
    assert.equal(seen[1]?.["resumed"], true);
    assert.equal(seen[1]?.["id"], seen[0]?.["id"], "the same session");
    assert.equal(seen[1]?.["prompt"], "TURN-2", "a resumed turn carries only the turn");
    const record = await store.read();
    assert.equal(record.turns, 2);
    assert.equal(record.rules, rulesHash(RULES));
  });

  it("starts afresh when the rules change, and when a resume is refused", async () => {
    const log = join(tmp, "json-calls-2.jsonl");
    process.env["CALLS"] = log;
    const runner = {
      name: "brain",
      argv: [process.execPath, jsonScript],
      resume: [process.execPath, jsonScript, "--resume", "{session}"],
      session: "claude-json" as const,
      cwd: tmp,
    };
    const store = new SessionStore(join(tmp, "big-session-2.json"));
    const mind = new ResumeMind(runner, store);
    await mind.turn({ rules: RULES, turn: "A", timeoutMs: 10_000 });
    await mind.turn({ rules: "RULES-V2", turn: "B", timeoutMs: 10_000 });
    process.env["FAIL_RESUME"] = "1";
    const failed = await mind.turn({ rules: "RULES-V2", turn: "C", timeoutMs: 10_000 });
    delete process.env["FAIL_RESUME"];
    assert.equal(failed.ok, true, "a refused resume falls back to a fresh session");
    const seen = await calls(log);
    assert.deepEqual(
      seen.map((call) => [call["resumed"], String(call["prompt"]).includes("RULES")]),
      [
        [false, true],
        [false, true],
        [true, false],
        [false, true],
      ],
    );
  });

  it("continues the same session regardless of its turn count", async () => {
    const log = join(tmp, "json-long-session.jsonl");
    process.env["CALLS"] = log;
    const store = new SessionStore(join(tmp, "big-session-3.json"));
    const runner = {
      name: "brain",
      argv: [process.execPath, jsonScript],
      resume: [process.execPath, jsonScript, "--resume", "{session}"],
      session: "claude-json" as const,
      cwd: tmp,
    };
    const startedAt = "2026-11-04T00:00:00.000Z";
    for (const turns of [59, 60, 120, 10_000]) {
      await store.write({ id: "old", rules: rulesHash(RULES), turns, startedAt });
      const mind = new ResumeMind(runner, store);
      assert.equal(await mind.primed(RULES), true);
      const result = await mind.turn({ rules: RULES, turn: "NEXT", timeoutMs: 10_000 });
      assert.equal(result.ok, true);
      const record = await store.read();
      assert.equal(record.id, "old");
      assert.equal(record.turns, turns + 1);
      assert.equal(record.startedAt, startedAt);
    }
    const seen = await calls(log);
    assert.equal(seen.length, 4);
    assert.ok(seen.every((call) => call["resumed"] === true && call["id"] === "old"));
    assert.ok(seen.every((call) => call["prompt"] === "NEXT"));
  });

  it("reads a session id from claude and codex output", () => {
    assert.equal(sessionIdOf("claude-json", '{"type":"result","session_id":"abc-1"}'), "abc-1");
    assert.equal(
      sessionIdOf("codex-jsonl", '{"type":"thread.started","thread_id":"t-9"}\n{"type":"x"}'),
      "t-9",
    );
    assert.equal(sessionIdOf("claude-json", "not json"), undefined);
    assert.equal(
      sessionIdOf(
        "claude-json",
        'We are changing auto mode billing. Nothing breaks.\n{"type":"result","session_id":"abc-2"}',
      ),
      "abc-2",
      "past a notice Claude Code printed first",
    );
  });
});

describe("a session kept up (claude-stream)", () => {
  it("keeps one process for many turns, and resumes the session after it ends", async () => {
    const log = join(tmp, "stream-calls.jsonl");
    process.env["CALLS"] = log;
    const runner = {
      name: "brain",
      argv: [process.execPath, streamScript],
      resume: [process.execPath, streamScript, "--resume", "{session}"],
      session: "claude-stream" as const,
      cwd: tmp,
    };
    const path = join(tmp, "stream-session.json");
    const mind = new StreamMind(runner, new SessionStore(path));
    const turnNames = Array.from({ length: 65 }, (_, index) => `T${index + 1}`);
    for (const turn of turnNames) {
      const result = await mind.turn({ rules: RULES, turn, timeoutMs: 10_000 });
      assert.equal(result.ok, true);
    }
    assert.equal((await new SessionStore(path).read()).turns, 65);
    await mind.close();
    const again = new StreamMind(runner, new SessionStore(path));
    assert.equal(await again.primed(RULES), true);
    await again.turn({ rules: RULES, turn: "T66", timeoutMs: 10_000 });
    await again.close();

    const seen = await calls(log);
    const spawns = seen.filter((call) => call["spawn"] === true);
    assert.equal(spawns.length, 2, "one process for 65 turns, one more after the restart");
    assert.equal(spawns[1]?.["resumed"], true);
    assert.equal(spawns[1]?.["id"], spawns[0]?.["id"]);
    const turns = seen.filter((call) => call["turn"] !== undefined).map((call) => call["turn"]);
    assert.match(String(turns[0]), /^You are the big superagent/, "the first turn has the rules");
    assert.deepEqual(turns.slice(1), [...turnNames.slice(1), "T66"]);
  });

  it("resumes a long session and still starts afresh when standing rules change", async () => {
    const log = join(tmp, "stream-long-session.jsonl");
    process.env["CALLS"] = log;
    const runner = {
      name: "brain",
      argv: [process.execPath, streamScript],
      resume: [process.execPath, streamScript, "--resume", "{session}"],
      session: "claude-stream" as const,
      cwd: tmp,
    };
    const store = new SessionStore(join(tmp, "stream-long-session.json"));
    const startedAt = "2026-11-04T00:00:00.000Z";
    await store.write({ id: "long-lived", rules: rulesHash(RULES), turns: 10_000, startedAt });
    const mind = new StreamMind(runner, store);
    try {
      assert.equal(await mind.primed(RULES), true);
      const resumed = await mind.turn({ rules: RULES, turn: "A", timeoutMs: 10_000 });
      assert.equal(resumed.ok, true);
      assert.deepEqual(await store.read(), {
        id: "long-lived",
        rules: rulesHash(RULES),
        turns: 10_001,
        startedAt,
      });
      const changed = await mind.turn({ rules: "RULES-V2", turn: "B", timeoutMs: 10_000 });
      assert.equal(changed.ok, true);
      const record = await store.read();
      assert.notEqual(record.id, "long-lived");
      assert.equal(record.rules, rulesHash("RULES-V2"));
      assert.equal(record.turns, 1);
    } finally {
      await mind.close();
    }
    const seen = await calls(log);
    const spawns = seen.filter((call) => call["spawn"] === true);
    assert.equal(spawns.length, 2);
    assert.deepEqual(
      spawns.map((call) => call["resumed"]),
      [true, false],
    );
    assert.deepEqual(
      seen.filter((call) => call["turn"] !== undefined).map((call) => call["turn"]),
      ["A", "RULES-V2\n\nB"],
    );
  });

  it("gives up on a turn that never answers, and starts again on the next", async () => {
    const log = join(tmp, "stream-hang.jsonl");
    process.env["CALLS"] = log;
    process.env["HANG"] = "1";
    const runner = {
      name: "brain",
      argv: [process.execPath, streamScript],
      session: "claude-stream" as const,
      cwd: tmp,
    };
    const mind = new StreamMind(runner, new SessionStore(join(tmp, "hang-session.json")));
    const result = await mind.turn({ rules: RULES, turn: "T1", timeoutMs: 400 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "timed out");
    delete process.env["HANG"];
    const next = await mind.turn({ rules: RULES, turn: "T2", timeoutMs: 10_000 });
    assert.equal(next.ok, true);
    await mind.close();
    assert.equal((await calls(log)).filter((call) => call["spawn"] === true).length, 2);
  });
});

describe("which session a runner allows", () => {
  const base = { name: "brain", argv: ["claude", "-p"], cwd: tmp };
  it("is kept up, resumed, or none", () => {
    const options = { home: tmp, name: "big" };
    assert.equal(mindFor({ ...base, session: "claude-stream" }, options).kind, "stream");
    assert.equal(
      mindFor(
        { ...base, session: "claude-json", resume: ["claude", "--resume", "{session}"] },
        options,
      ).kind,
      "resume",
    );
    assert.equal(mindFor({ ...base, session: "claude-json" }, options).kind, "none");
    assert.ok(mindFor(base, options) instanceof OneShotMind);
  });
});
