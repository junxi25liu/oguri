/**
 * What a run reads on stdin, besides the task itself.
 *
 * Plain text the agent reads like the rest of the prompt. Each piece is a pure
 * function, so what an agent is told about a rerun, a follow-up, or the chat
 * it is working for is testable without a child process.
 */

import type { TaskOrigin } from "@oguri/protocol";

import { resultFooter } from "./result.ts";

/** Prepended to every run of a task this agent ran before (ADR 0030 §9). */
export const RECOVERY_NOTE =
  "This task ran before on this machine. Before repeating any outside action (push, PR, comment, deploy), check the working directory, git log, and the remote for what was already done.";

/** At most this many conversation messages go into a full prompt; older ones stay in the thread. */
const CONVERSATION_LIMIT = 50;

/** One message from the task's thread, as an agent reads it. */
export interface ThreadLine {
  id: string;
  ts: string;
  /** Who wrote it: a person's display name, or `you` for this worker's own replies. */
  author: string;
  body: string;
}

/**
 * The footer for a task requested from a chat (ADR 0030 §7).
 *
 * The worker posts the acknowledgement and the result itself, so the agent is
 * told to stay quiet and to say only what a person must read.
 */
export function relayFooter(origin: TaskOrigin): string {
  return [
    "",
    "---",
    `oguri: the person who asked is in a chat (${origin.source}). They see an acknowledgement and your final result, nothing else.`,
    "Do not post progress. If they asked you a direct question, answer it with oguri_task action=answer. If they ask for something beyond this task, use oguri_task action=handback.",
    'Put your final answer for them in result.json "summary" (and "pr" when there is a pull request).',
    "",
  ].join("\n");
}

function lines(messages: readonly ThreadLine[]): string {
  return messages.map((m) => `${m.author}: ${m.body.trim()}`).join("\n\n");
}

/** The stdin of a resumed session: only what is new since the agent last spoke. */
export function resumeText(messages: readonly ThreadLine[]): string {
  return `A person followed up in the task's thread:\n\n${lines(messages)}`;
}

/**
 * The stdin of a follow-up that cannot resume a session: the task again, then
 * the conversation so far, with the new messages set apart.
 */
export function conversationText(
  body: string,
  conversation: readonly ThreadLine[],
  fresh: readonly ThreadLine[],
): string {
  const freshIds = new Set(fresh.map((m) => m.id));
  const earlier = conversation.filter((m) => !freshIds.has(m.id)).slice(-CONVERSATION_LIMIT);
  return [
    body.trimEnd(),
    "",
    "---",
    ...(earlier.length === 0
      ? []
      : ["The conversation so far, oldest first:", "", lines(earlier), ""]),
    "New since the last run; act on this now:",
    "",
    lines(fresh),
  ].join("\n");
}

/** The full stdin of one run. */
/**
 * The footer for a run that has oguri's tools and no chat (ADR 0032), as
 * a standing superagent's work and handoff sections tell a worker.
 */
/**
 * How a worker keeps reachable while it works, from a standing superagent's
 * work section: a message reaches a live session between steps, so a step must
 * not block for long.
 */
export const WORK_RULES = [
  "Run a long command (a build, a test suite, a server) in the background and keep working, or end your turn; do not poll it, and do not report done while a job whose result you need still runs.",
  "Messages from the owner may arrive while you work. Read each one when it arrives and take it into account.",
];

export const TOOLS_FOOTER = [
  "",
  "---",
  "oguri: you are one worker of a team; a superagent or a person deployed you on this task.",
  "Resolve routine problems yourself. Use oguri_task action=progress for an internal update; it pauses nothing.",
  "When the owner must decide something concrete, use oguri_task action=ask with one question and needsHuman true, and keep working on what does not depend on it.",
  "If you are asked for work beyond this task, or for another task, use oguri_task action=handback with one sentence on why, and do not do it.",
  "Do not complete, cancel, or block this task with oguri_task: when you finish, write result.json and end; oguri reports the run, with its branch and log.",
  ...WORK_RULES,
  "",
].join("\n");

/**
 * The shell commands a Claude runner's argv allows (`--allowedTools
 * "Bash(git:*)"`), so the worker knows them up front instead of finding out
 * one refusal at a time. Empty when the argv allows Bash without a pattern,
 * or names none.
 */
export function allowedShellCommands(argv: readonly string[]): string[] {
  const commands: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--allowedTools" && argv[index] !== "--allowed-tools") continue;
    for (let next = index + 1; next < argv.length; next += 1) {
      const value = argv[next] as string;
      if (value.startsWith("-")) break;
      for (const part of value.split(/[,\s]+/)) {
        const match = /^Bash\(([^:)]+)(?::\*)?\)$/.exec(part.trim());
        if (match !== null && !commands.includes(match[1] as string))
          commands.push(match[1] as string);
      }
    }
  }
  return commands;
}

/** One line telling a worker which shell commands it may run. */
export function shellNote(commands: readonly string[]): string {
  if (commands.length === 0) return "";
  return `\noguri: the only shell commands you may run here are: ${commands.join(", ")}. Others are refused; read and search files with your file tools instead of the shell.\n`;
}

export function buildStdin(input: {
  /** The task text, or the follow-up text built above. */
  text: string;
  resultFile: string;
  /** This agent ran the task before on this machine. */
  ranBefore: boolean;
  origin?: TaskOrigin;
  /** The run has oguri's tools. */
  tools?: boolean;
  /** Shell commands the runner allows, when it names them. */
  shell?: readonly string[];
}): string {
  return [
    input.ranBefore ? `${RECOVERY_NOTE}\n\n` : "",
    input.text,
    resultFooter(input.resultFile),
    shellNote(input.shell ?? []),
    input.origin === undefined
      ? input.tools === true
        ? TOOLS_FOOTER
        : ""
      : relayFooter(input.origin),
  ].join("");
}
