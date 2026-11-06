import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isReplayLine, isResultLine, runExecutor, streamUserMessage } from "../src/runner.ts";
import { parseClaudeStream } from "../src/session.ts";
import { TOOLS_FOOTER, buildStdin } from "../src/prompt.ts";
import {
  MCP_CONFIG_FILE,
  REPLAY_FLAG,
  agentFlavor,
  withOguriTools,
  withReplay,
} from "../src/tools.ts";

/**
 * Live sessions and oguri's tools for a run (ADR 0032), as a live superagent's
 * worker sessions have them: a message reaches a session while it runs, and a
 * claude or codex run gets oguri's MCP server without the owner pasting it.
 */

const SESSION = "33333333-4444-5555-6666-777777777777";

/**
 * Behaves like `claude -p --input-format stream-json --output-format stream-json`:
 * one result per user message, each after a pause long enough for a message to
 * arrive mid-turn; it exits when stdin closes.
 */
const STREAMER = `
const fs = require("fs");
let buffer = "";
const queue = [];
let busy = false;
const turn = () => {
  if (busy || queue.length === 0) return;
  busy = true;
  const text = queue.shift();
  fs.appendFileSync(process.env.SEEN, text + "\\n---\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION)} }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: "result", session_id: ${JSON.stringify(SESSION)}, result: "answered: " + text.slice(0, 20) }));
    busy = false;
    turn();
  }, 400);
};
process.stdin.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (line.trim()) queue.push(JSON.parse(line).message.content[0].text);
  }
  turn();
});
process.stdin.on("end", () => { fs.appendFileSync(process.env.SEEN, "CLOSED\\n"); });
`;

/**
 * Behaves like real Claude with `--replay-user-messages`: it echoes each user
 * message as it reads it, and folds a message that arrives mid-turn into that
 * turn, so two messages get one result.
 */
const FOLDER = `
const fs = require("fs");
let buffer = "";
let turn = null;
const echo = (text) => console.log(JSON.stringify({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text }] } }));
const take = (text) => {
  fs.appendFileSync(process.env.SEEN, text + "\\n---\\n");
  echo(text);
  if (turn !== null) { turn.extra += 1; return; }
  turn = { extra: 0 };
  console.log(JSON.stringify({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: "result", session_id: ${JSON.stringify(SESSION)}, result: "one turn, " + (1 + turn.extra) + " message(s)" }));
    turn = null;
  }, 600);
};
process.stdin.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (line.trim()) take(JSON.parse(line).message.content[0].text);
  }
});
process.stdin.on("end", () => { fs.appendFileSync(process.env.SEEN, "CLOSED\\n"); });
`;

let tmp: string;
let script: string;
let folder: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-live-"));
  script = join(tmp, "streamer.cjs");
  await writeFile(script, STREAMER);
  folder = join(tmp, "folder.cjs");
  await writeFile(folder, FOLDER);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("a live session", () => {
  it("takes a message while it runs, answers both, and closes stdin when nothing waits", async () => {
    const seen = join(tmp, "seen.txt");
    let send: ((text: string) => boolean) | undefined;
    const run = runExecutor({
      argv: [process.execPath, script],
      cwd: tmp,
      prompt: "First: rename the button",
      timeoutMs: 20_000,
      logDir: join(tmp, "run1"),
      env: { ...process.env, SEEN: seen },
      live: { bind: (write) => (send = write) },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(send !== undefined, "the caller can write");
    assert.equal(send("Second: also the cancel button"), true);
    const result = await run;
    assert.equal(result.exitCode, 0);
    const log = await readFile(seen, "utf8");
    assert.match(log, /First: rename the button\n---\nSecond: also the cancel button\n---\nCLOSED/);
    const session = parseClaudeStream(await readFile(join(tmp, "run1", "stdout.log"), "utf8"));
    assert.equal(session.sessionId, SESSION);
    assert.equal(session.text, "answered: Second: also the can", "the last turn is the answer");
    assert.equal(send("too late"), false, "a closed session refuses more");
  });

  it("closes a session that folds a mid-turn message into one result, instead of hanging", async () => {
    const seen = join(tmp, "seen3.txt");
    let send: ((text: string) => boolean) | undefined;
    const run = runExecutor({
      argv: [process.execPath, folder],
      cwd: tmp,
      prompt: "First",
      timeoutMs: 10_000,
      logDir: join(tmp, "run3"),
      env: { ...process.env, SEEN: seen },
      live: { bind: (write) => (send = write), replay: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(send?.("Second, mid-turn"), true);
    const result = await run;
    assert.equal(result.timedOut, false, "it must not wait for a second result");
    assert.equal(result.exitCode, 0);
    assert.match(await readFile(seen, "utf8"), /First\n---\nSecond, mid-turn\n---\nCLOSED/);
    const session = parseClaudeStream(await readFile(join(tmp, "run3", "stdout.log"), "utf8"));
    assert.equal(session.text, "one turn, 2 message(s)");
  });

  it("adds the echo flag to a live claude argv only", () => {
    assert.deepEqual(withReplay(["claude", "-p"]), ["claude", "-p", REPLAY_FLAG]);
    assert.deepEqual(withReplay(["claude", REPLAY_FLAG]), ["claude", REPLAY_FLAG]);
    assert.deepEqual(withReplay(["node", "x.cjs"]), ["node", "x.cjs"]);
    assert.equal(
      isReplayLine(
        '{"type":"user","isReplay":true,"message":{"content":[{"type":"text","text":"hi"}]}}',
      ),
      true,
    );
    assert.equal(
      isReplayLine(
        '{"type":"user","isReplay":true,"message":{"content":[{"type":"tool_result","content":"x"}]}}',
      ),
      false,
      "a tool result is not a message",
    );
  });

  it("closes stdin after the first result when nothing else arrives", async () => {
    const seen = join(tmp, "seen2.txt");
    const result = await runExecutor({
      argv: [process.execPath, script],
      cwd: tmp,
      prompt: "Only this",
      timeoutMs: 20_000,
      logDir: join(tmp, "run2"),
      env: { ...process.env, SEEN: seen },
      live: { bind: () => undefined },
    });
    assert.equal(result.exitCode, 0);
    assert.match(await readFile(seen, "utf8"), /Only this\n---\nCLOSED/);
    assert.equal(result.messagesRead, 1, "one message written, one result");
  });

  it("counts a message as read only once the session echoed it", async () => {
    const seen = join(tmp, "seen4.txt");
    let send: ((text: string) => boolean) | undefined;
    const run = runExecutor({
      argv: [process.execPath, folder],
      cwd: tmp,
      prompt: "First",
      timeoutMs: 10_000,
      logDir: join(tmp, "run4"),
      env: { ...process.env, SEEN: seen },
      live: { bind: (write) => (send = write), replay: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(send?.("Second, mid-turn"), true);
    const result = await run;
    assert.equal(result.messagesRead, 2, "both were echoed before the one result");
  });

  it("reports no messages read for a run that is not a live session", async () => {
    const result = await runExecutor({
      argv: ["sh", "-c", "exit 0"],
      cwd: tmp,
      prompt: "",
      timeoutMs: 5_000,
      logDir: join(tmp, "run5"),
    });
    assert.equal(result.messagesRead, undefined);
  });

  it("writes and reads stream-json lines", () => {
    assert.deepEqual(JSON.parse(streamUserMessage("hi")), {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    assert.equal(isResultLine('{"type":"result","result":"x"}'), true);
    assert.equal(isResultLine('{"type":"assistant","message":{"content":"result"}}'), false);
    assert.equal(isResultLine("not json result"), false);
  });
});

describe("oguri's tools for a run", () => {
  const server = { command: "/usr/local/bin/oguri", args: ["mcp"] };
  const env = (runDir: string) => ({
    home: "/h",
    agentId: "box-claude",
    taskId: "01K0000000000000000000000A",
    room: "superagent",
    runDir,
    resultFile: join(runDir, "result.json"),
  });

  it("adds oguri's MCP server to a claude argv, allowing only its tools", async () => {
    const argv = await withOguriTools(["claude", "-p", "--output-format", "json"], {
      server,
      env: env(tmp),
    });
    assert.deepEqual(argv.slice(0, 4), ["claude", "-p", "--output-format", "json"]);
    assert.deepEqual(argv.slice(4), [
      "--mcp-config",
      join(tmp, MCP_CONFIG_FILE),
      "--allowedTools",
      "mcp__oguri",
      `Edit(/${join(tmp, "result.json")})`,
    ]);
    const config = JSON.parse(await readFile(join(tmp, MCP_CONFIG_FILE), "utf8")) as {
      mcpServers: { oguri: { command: string; env: Record<string, string> } };
    };
    assert.equal(config.mcpServers.oguri.command, "/usr/local/bin/oguri");
    assert.equal(config.mcpServers.oguri.env["OGURI_TASK_ID"], "01K0000000000000000000000A");
  });

  it("adds it to codex as config overrides", async () => {
    const argv = await withOguriTools(["/opt/bin/codex", "exec", "--json"], {
      server,
      env: env(tmp),
    });
    assert.equal(argv[3], "-c");
    assert.match(argv.join(" "), /mcp_servers\.oguri\.command="\/usr\/local\/bin\/oguri"/);
    assert.match(argv.join(" "), /OGURI_TASK_ROOM = "superagent"/);
  });

  it("leaves the argv exactly as written otherwise", async () => {
    const node = [process.execPath, "fake.cjs"];
    assert.deepEqual(await withOguriTools(node, { server, env: env(tmp) }), node);
    const off = ["claude", "-p"];
    assert.deepEqual(await withOguriTools(off, { server, oguriTools: false, env: env(tmp) }), off);
    const own = ["claude", "-p", "--mcp-config", "/mine.json"];
    assert.deepEqual(await withOguriTools(own, { server, env: env(tmp) }), own);
    assert.deepEqual(await withOguriTools(off, { env: env(tmp) }), off, "no server known");
    assert.equal(agentFlavor(["C:\\\\tools\\\\claude.exe"]), "claude");
  });

  it("tells a run with tools how to use them, and a chat task about its chat instead", () => {
    const text = buildStdin({
      text: "Do it",
      resultFile: "/r.json",
      ranBefore: false,
      tools: true,
    });
    assert.ok(text.includes(TOOLS_FOOTER));
    assert.match(text, /oguri_task action=handback/);
    const chat = buildStdin({
      text: "Do it",
      resultFile: "/r.json",
      ranBefore: false,
      tools: true,
      origin: { source: "feishu", conversation: "oc", message: "om", requester: "ou" },
    });
    assert.ok(!chat.includes(TOOLS_FOOTER));
  });
});
