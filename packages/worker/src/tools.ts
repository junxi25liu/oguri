/**
 * oguri's own tools for a run, and messages for a run in flight (ADR 0032).
 *
 * Every worker session gets its tools: report progress, ask a
 * person, hand a request back. Here the worker adds oguri's MCP server to a
 * `claude` or `codex` argv, so a run has `oguri_task` without the owner
 * pasting a config. Only oguri's own server is added; everything else in the
 * argv is the owner's, exactly as written. `oguriTools: false` turns it off.
 *
 * A live session (`session: claude-stream`) also takes a person's message
 * while it runs, as a live superagent steers a worker's inbox.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TaskDetail, WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import { followupAuthors, pendingMessages, threadLines } from "./followup.ts";
import { resumeText } from "./prompt.ts";

/** How a run starts oguri's MCP server, as the CLI that runs the worker knows it. */
export interface McpServer {
  command: string;
  args: string[];
}

export const MCP_SERVER_NAME = "oguri";
export const MCP_CONFIG_FILE = "mcp.json";

/** Which agent CLI an argv runs, by its command's name. */
export function agentFlavor(argv: readonly string[]): "claude" | "codex" | undefined {
  const name =
    (argv[0] ?? "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd)$/i, "") ?? "";
  return name === "claude" || name === "codex" ? name : undefined;
}

/** True when the owner already gave the argv an MCP config of their own. */
function configured(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith("--mcp-config") || arg.includes("mcp_servers.oguri"));
}

/** The flag that makes Claude echo each user message as it reads it. */
export const REPLAY_FLAG = "--replay-user-messages";

/**
 * A live Claude session's argv, echoing what it reads (ADR 0032 §1). Without
 * the echo the worker cannot tell a message folded into the current turn from
 * one still waiting, and would hold the session open until its timeout.
 */
export function withReplay(argv: readonly string[]): string[] {
  if (agentFlavor(argv) !== "claude" || argv.includes(REPLAY_FLAG)) return [...argv];
  return [...argv, REPLAY_FLAG];
}

/**
 * A Claude permission rule for exactly one file. An absolute path is written
 * with a leading `//`, as Claude's permission rules spell one.
 */
export function resultRule(resultFile: string): string {
  const path = resultFile.replaceAll("\\", "/");
  return `Edit(${path.startsWith("/") ? "/" : "//"}${path})`;
}

/** What the MCP server needs to act for this run's task. */
export interface ToolEnv {
  home: string;
  agentId: string;
  taskId: string;
  room: string;
  runDir: string;
  resultFile: string;
}

function serverEnv(env: ToolEnv): Record<string, string> {
  return {
    OGURI_HOME: env.home,
    OGURI_AGENT: env.agentId,
    OGURI_TASK_ID: env.taskId,
    OGURI_TASK_ROOM: env.room,
    OGURI_RUN_DIR: env.runDir,
    OGURI_RESULT_FILE: env.resultFile,
  };
}

/**
 * The argv a run starts with: the owner's, plus oguri's MCP server when the
 * runner is `claude` or `codex` and `oguriTools` is not false.
 */
export async function withOguriTools(
  argv: readonly string[],
  options: { oguriTools?: boolean; server?: McpServer; env: ToolEnv },
): Promise<string[]> {
  const flavor = agentFlavor(argv);
  if (options.oguriTools === false || options.server === undefined || flavor === undefined) {
    return [...argv];
  }
  if (configured(argv)) return [...argv];
  const { command, args } = options.server;
  const env = serverEnv(options.env);
  if (flavor === "claude") {
    const path = join(options.env.runDir, MCP_CONFIG_FILE);
    const config = { mcpServers: { [MCP_SERVER_NAME]: { command, args, env } } };
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    // `-p` refuses tools it was not allowed; these are oguri's own and nothing else:
    // its MCP tools, and writing this run's own result.json, which sits next to
    // the run's working directory and so outside what --permission-mode
    // acceptEdits allows. Nothing else in the run directory is opened.
    return [
      ...argv,
      "--mcp-config",
      path,
      "--allowedTools",
      `mcp__${MCP_SERVER_NAME}`,
      resultRule(options.env.resultFile),
    ];
  }
  const quote = (value: string): string => JSON.stringify(value);
  const table = Object.entries(env)
    .map(([key, value]) => `${key} = ${quote(value)}`)
    .join(", ");
  return [
    ...argv,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.command=${quote(command)}`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.args=[${args.map(quote).join(", ")}]`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.env={ ${table} }`,
  ];
}

/**
 * Messages from a person that reached a live run's thread and have not been
 * given to it yet, from the task's creator, a trusted requester, or this agent
 * relaying someone, as a follow-up would be (ADR 0030 §5).
 */
export async function newMessagesFor(
  backend: Backend,
  input: {
    room: string;
    taskId: string;
    thread: string;
    agentId: string;
    since: string;
    policy: Pick<WorkerPolicy, "trustedRequesters">;
    given: ReadonlySet<string>;
  },
): Promise<Message[]> {
  const detail = await backend.call<TaskDetail>("taskShow", {
    room: input.room,
    taskId: input.taskId,
  });
  const messages = await backend.call<Message[]>("read", {
    room: input.room,
    thread: input.thread,
  });
  const trusted = followupAuthors(
    detail.task.creator,
    input.policy.trustedRequesters,
    input.agentId,
  );
  return pendingMessages(Array.isArray(messages) ? messages : [], {
    thread: input.thread,
    agentId: input.agentId,
    since: input.since,
    consumed: input.given,
  }).filter((message) => trusted(message.header.from));
}

/** What a live session reads for messages that arrived while it ran. */
export function liveText(messages: readonly Message[], agentId: string): string {
  return `${resumeText(threadLines(messages, agentId))}\n\nThis arrived while you were working. Take it into account in the same task.`;
}
