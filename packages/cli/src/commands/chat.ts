/**
 * `oguri chat` — a terminal conversation with the big or a small superagent.
 *
 * The terminal owns only its own input loop. Every message and answer is an
 * immutable record in the conversation room, read through `ChatService`, so a
 * disconnected terminal, a second tab, or a late reply lose nothing. Exiting
 * closes only this process's Backend: it never stops the daemon, a superagent,
 * or a worker. No message is ever sent again on a refresh or a timeout.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadLocalPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import {
  ChatService,
  isThreadId,
  parseChatTarget,
  type ChatConversation,
  type ChatMessage,
  type ChatTarget,
} from "../chat/service.ts";
import { type Ctx, str, usage } from "../context.ts";
import { bold, cyan, dim, green, out, red, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";

/** Commands are local to the terminal; they are never written to the network. */
const HELP = [
  "/help              show these commands",
  "/target [name]     show or switch target (big, an agent id, machine:<id>)",
  "/targets           list known targets",
  "/history           re-read this target's conversation",
  "/exit              leave this terminal (or Ctrl-D / Ctrl-C)",
  "",
  "Enter sends · Ctrl-C interrupts a wait, not the superagent",
  "A slash command starts with /; write // to send a literal leading slash.",
].join("\n");

function time(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts.slice(11, 19) : date.toLocaleTimeString();
}

function line(message: ChatMessage): string {
  const who = message.role === "you" ? bold("you") : bold(cyan(message.from));
  const state =
    message.state === "failed"
      ? ` ${red("failed")}`
      : message.state === "waiting"
        ? ` ${yellow("waiting")}`
        : "";
  return `${dim(time(message.ts))} ${who}${state}  ${message.body.replaceAll("\n", "\n  ")}`;
}

function status(conversation: ChatConversation): string {
  const hint =
    conversation.presence === "away"
      ? yellow(" · the small's session is away")
      : conversation.presence === "stale"
        ? yellow(" · presence is stale")
        : conversation.presence === "live"
          ? green(" · live")
          : "";
  return dim(`  ${conversation.target.label} · room ${conversation.room}${hint}`);
}

function showNew(
  conversation: ChatConversation,
  seen: Set<string>,
  write: (line: string) => void = out,
): void {
  for (const message of conversation.messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    write(line(message));
  }
  for (const error of conversation.errors) write(yellow(`  ${error}`));
  if (conversation.timedOut) {
    write(yellow("  no reply yet. Is 'oguri superagent start' running for this target?"));
    write(dim("  the request stays in the conversation; /history will show a late answer"));
  } else if (conversation.waiting) {
    write(dim("  waiting for an answer; replies can arrive after you leave · /history to re-read"));
  }
}

/** The interactive loop, split out so a non-TTY stream can be tested. */
export async function chatLoop(
  service: ChatService,
  io: Interface,
  options: {
    target: ChatTarget;
    thread?: string;
    waitMs?: number;
    isTty?: boolean;
    targets?: () => Promise<ChatTarget[]>;
    write?: (line: string) => void;
    onWait?: (waiting: boolean) => void;
  },
): Promise<number> {
  let target = options.target;
  let thread = options.thread;
  const seen = new Set<string>();
  const isTty = options.isTty ?? true;
  const write = options.write ?? out;
  const prompt = (): string => `${green("chat")} ${cyan(target.value)} ${dim("›")} `;

  const refresh = async (header = false): Promise<ChatConversation> => {
    const conversation = await service.history(target, thread === undefined ? {} : { thread });
    if (header) write(status(conversation));
    showNew(conversation, seen, write);
    if (conversation.thread !== null) thread = conversation.thread;
    return conversation;
  };

  if (isTty) {
    write(bold("oguri chat"));
    write(dim("  type /help for commands · /exit to leave"));
    await refresh(true);
  }

  while (true) {
    let text: string;
    try {
      text = await io.question(isTty ? prompt() : "");
    } catch {
      // EOF / Ctrl-D: the process ends, the conversation does not.
      return 0;
    }
    const trimmed = text.trim();
    if (trimmed === "" && !isTty) return 0;
    if (trimmed === "") continue;
    if (trimmed === "/exit" || trimmed === "/quit") return 0;
    if (trimmed === "/help") {
      write(HELP);
      continue;
    }
    if (trimmed === "/history") {
      await refresh();
      continue;
    }
    if (trimmed === "/targets" || trimmed.startsWith("/target")) {
      const word = trimmed === "/targets" ? undefined : trimmed.slice("/target".length).trim();
      if (word === undefined || word === "") {
        const choices = await (options.targets ?? (() => service.targets()))();
        write(dim(`  current: ${target.value}`));
        for (const choice of choices) write(dim(`  ${choice.value}  ${choice.label}`));
        continue;
      }
      try {
        const next = parseChatTarget(word);
        if (next.value !== target.value) {
          target = next;
          thread = undefined;
          seen.clear();
          write(green(`  switched to ${target.value}`));
          await refresh(true);
        }
      } catch (error) {
        write(red(`  ${error instanceof Error ? error.message : String(error)}`));
      }
      continue;
    }
    const body = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
    let sent: ChatMessage;
    try {
      sent = await service.send(target, body, thread);
    } catch (error) {
      write(red(`  could not send: ${error instanceof Error ? error.message : String(error)}`));
      write(dim("  nothing was written; fix the target or the connection and try again"));
      continue;
    }
    seen.add(sent.id);
    write(line({ ...sent, state: "waiting" }));
    thread = sent.thread ?? sent.id;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    process.once("SIGINT", onAbort);
    options.onWait?.(true);
    try {
      const waitOptions: { timeoutMs?: number; signal: AbortSignal } = {
        signal: controller.signal,
      };
      if (options.waitMs !== undefined) waitOptions.timeoutMs = options.waitMs;
      const conversation = await service.waitForReply(target, sent.id, waitOptions);
      showNew(conversation, seen, write);
      if (conversation.thread !== null) thread = conversation.thread;
    } finally {
      options.onWait?.(false);
      process.off("SIGINT", onAbort);
    }
  }
}

export async function cmdChat(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const room = policy.superagent.big.room;
  const threadParam = str(ctx, "thread");
  if (threadParam !== undefined && !isThreadId(threadParam)) {
    usage("--thread must be a message id");
  }
  const thread = threadParam;
  let target: ChatTarget;
  try {
    target = parseChatTarget(str(ctx, "target") ?? "big");
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  const self = ctx.config.agent.id;
  const waitS = Number(str(ctx, "wait") ?? "300");
  const waitMs = Number.isFinite(waitS) ? Math.max(0, waitS * 1000) : undefined;
  const isTty = input.isTTY === true && output.isTTY === true;

  return await withBackend(ctx, async (backend: Backend) => {
    const service = new ChatService({ backend, self, room });
    const io = createInterface({ input, output, terminal: isTty });
    let waiting = false;
    const onInterrupt = (): void => {
      if (!waiting) io.close();
    };
    process.once("SIGINT", onInterrupt);
    try {
      return await chatLoop(service, io, {
        target,
        ...(thread === undefined ? {} : { thread }),
        ...(waitMs === undefined ? {} : { waitMs }),
        isTty,
        onWait: (value) => {
          waiting = value;
        },
      });
    } finally {
      io.close();
      process.off("SIGINT", onInterrupt);
    }
  });
}
