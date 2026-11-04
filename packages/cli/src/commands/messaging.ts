import { Network, resolveNetwork, resolveProjectBinding } from "@oguri/core";
import { type Backend } from "@oguri/daemon";
import { type Message, assertMachineId, assertRoomId, machineMention } from "@oguri/protocol";
import { bold, dim, errline, green, json, messageToJson, out, red, yellow } from "../output.ts";

import { type Ctx, bool, list, str, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

/**
 * Warn when a mention will not reach the agent it names.
 *
 * Printed after the send rather than blocking it: the forecast is a hint, the
 * peer may have joined a moment ago, and refusing would be worse than a silent
 * miss. But the miss must be visible — an unanswered question whose recipient
 * never followed the room reads exactly like being ignored.
 */
async function warnUndeliverable(
  be: Backend,
  room: string,
  mentions: readonly string[],
): Promise<void> {
  if (mentions.length === 0) return;
  const forecast = await be
    .call<{ agent: string; outlook: string; reason: string }[]>("forecastDelivery", {
      room,
      agents: mentions,
    })
    .catch(() => []);
  for (const entry of forecast) {
    if (entry.outlook === "misses") {
      errline(yellow(`! ${entry.agent} ${entry.reason}`));
      errline(dim(`  ask them to run: oguri room join ${room}`));
    } else if (entry.outlook === "unknown") {
      errline(dim(`? ${entry.agent}: ${entry.reason}`));
    }
  }
}

/** A room holding commits the remote has not seen. See `Network.outbox`. */
interface OutboxRow {
  roomId: string;
  ahead: number;
  since: string | null;
  reason: string | null;
}

/** Whether this room still holds unpushed commits, and why. */
async function queuedIn(be: Backend, room: string): Promise<OutboxRow | null> {
  const rows = await be.call<OutboxRow[]>("outbox").catch(() => []);
  return rows.find((row) => row.roomId === room) ?? null;
}

/**
 * Say which of the two states a write actually reached.
 *
 * A message is committed to the room branch before it is pushed, so a failed
 * push leaves it **written and safe**, going out on the next sync. oguri used
 * to report that as a hard error carrying raw git plumbing — and a sender who
 * believes "your message failed" sends it again, into a log where the duplicate
 * is permanent. The distinction is the whole point: `sent` means the remote has
 * it; `queued` means this machine does, and will keep trying.
 */
function reportDelivery(id: string, queued: OutboxRow | null): void {
  if (queued === null) {
    out(green("✓ sent") + dim(` ${id}`));
    return;
  }
  out(yellow("⧗ queued") + dim(` ${id}`) + " — written here, not yet on the remote");
  if (queued.reason !== null) out(dim(`  remote said: ${queued.reason}`));
  out(dim("  it goes out on the next sync; retry now with: oguri sync"));
  out(dim("  do NOT send it again — the message is safe, and a duplicate is permanent"));
}

export async function cmdSend(ctx: Ctx, asQuestion: boolean): Promise<number> {
  const roomId = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ");
  if (roomId === undefined || body === "") {
    usage(asQuestion ? "ask needs a room and a question" : "send needs a room and a message");
  }
  assertRoomId(roomId);

  // `ask` defaults to `agent`, not `human`.
  //
  // Parking on a person by default made `needs: human` the ordinary case, and a
  // marker that fires by default stops carrying information: an inbox where most
  // items claim to need a decision is one nobody can triage. Most questions
  // between agents are answerable from a repository by the agent that owns it.
  // Escalating is now the deliberate act, with `--needs human`.
  const needs = str(ctx, "needs") ?? (asQuestion ? "agent" : "none");
  const kind = str(ctx, "kind") ?? (asQuestion ? "question" : "msg");
  // `--machine <id>` addresses a computer rather than one agent on it. It is a
  // mention like any other once expanded, so it composes with `--mention`.
  const mentions = [
    ...list(ctx, "mention"),
    ...list(ctx, "machine").map((id) => machineMention(assertMachineId(id))),
  ];
  const tags = list(ctx, "tag");
  const priority = str(ctx, "priority");
  const replyTo = str(ctx, "reply-to");
  const forceUnsafe = str(ctx, "force-unsafe");

  return await withBackend(ctx, async (be) => {
    const message = await be.call<Message>("send", {
      room: roomId,
      input: {
        body,
        kind,
        needs,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(priority === undefined ? {} : { priority }),
        ...(replyTo === undefined ? {} : { inReplyTo: replyTo }),
        ...(forceUnsafe === undefined ? {} : { forceUnsafe }),
      },
    });
    const queued = await queuedIn(be, roomId);
    if (bool(ctx, "json")) {
      json({ ...messageToJson(message), delivery: queued === null ? "pushed" : "queued" });
      return 0;
    }
    reportDelivery(message.header.id, queued);
    await warnUndeliverable(be, roomId, message.header.mentions);
    if (message.header.needs === "human") {
      out(dim("  parked — surface this to a human; relay attribution is cooperative."));
    }
    if (message.header.tags.includes("reply-budget")) out(replyBudgetHint(message.header.thread));
    return 0;
  });
}

/**
 * Prompt before recording an answer as relayed from a human.
 *
 * Requiring a TTY prevents accidental non-interactive use. It does not prove a
 * person supplied the input; shell-capable agents can also control terminals.
 */
async function confirmAtTerminal(request: {
  room: string;
  from: string;
  question: string;
  answer: string;
}): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    errline(
      red("✗ --as-human needs an interactive terminal.") +
        "\n  This best-effort check prevents accidental non-interactive attribution;" +
        "\n  it does not authenticate a human. Run the relay from a terminal.",
    );
    return false;
  }

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    out("");
    out(bold("Recording this as a HUMAN-RELAYED decision permanently:"));
    out(dim(`  room     #${request.room}`));
    out(dim(`  asked by ${request.from}`));
    out(`  ${dim("Q:")} ${request.question.trim().split("\n")[0] ?? ""}`);
    out(`  ${dim("A:")} ${request.answer.trim().split("\n")[0] ?? ""}`);
    out("");
    const reply = await rl.question(`${yellow("Confirm this human-relayed decision?")} [y/N] `);
    return /^y(es)?$/i.test(reply.trim());
  } finally {
    rl.close();
  }
}

/**
 * Promote a settled outcome to the permanent record.
 *
 * This existed over MCP and in the design document's CLI surface, but not in
 * the CLI itself — so a shell-driven agent could hold the whole discussion and
 * then have no way to record what it concluded. That gap matters more than a
 * missing convenience: sealing prunes ordinary messages out of the live window
 * and decisions are what it never prunes, so an unrecorded outcome is one that
 * disappears at the next compaction.
 */
export async function cmdDecide(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  const title = ctx.positionals[2];
  const body = ctx.positionals.slice(3).join(" ");
  if (roomId === undefined || title === undefined) {
    usage('decide needs a room and a title: oguri decide <room> "<title>" "<what was decided>"');
  }
  assertRoomId(roomId);

  const supersedes = str(ctx, "reply-to");
  return await withBackend(ctx, async (be) => {
    const message = await be.call<Message>("send", {
      room: roomId,
      input: {
        body: body === "" ? title : `${title}\n\n${body}`,
        kind: "decision",
        needs: "none",
        ...(supersedes === undefined ? {} : { inReplyTo: supersedes }),
      },
    });
    if (bool(ctx, "json")) {
      json(messageToJson(message));
      return 0;
    }
    const queued = await queuedIn(be, roomId);
    if (queued === null) out(green("✓ decision recorded") + dim(` ${message.header.id}`));
    else reportDelivery(message.header.id, queued);
    out(dim("  decisions are never pruned by sealing — this outlives the live window"));
    return 0;
  });
}

export async function cmdAnswer(ctx: Ctx): Promise<number> {
  const messageId = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ");
  if (messageId === undefined || body === "") usage("answer needs a message id and a reply");

  // `--as-human` runs DIRECT, never through the daemon: the confirmation needs
  // this process's terminal, and a socket has no human on the other end.
  if (bool(ctx, "as-human")) {
    const selectedNetwork =
      str(ctx, "network") ?? resolveProjectBinding(ctx.config, process.cwd())?.network;
    const netConfig = resolveNetwork(ctx.config, selectedNetwork);
    const network = Network.open(ctx.layout, netConfig, ctx.config.agent);
    try {
      const message = await network.answer(messageId, body, {
        confirmHuman: (request) => confirmAtTerminal(request),
      });
      if (bool(ctx, "json")) json(messageToJson(message));
      else out(green("✓ recorded as a human-relayed decision") + dim(` ${message.header.id}`));
      return 0;
    } finally {
      network.close();
    }
  }

  return await withBackend(ctx, async (be) => {
    const message = await be.call<Message>("answer", { messageId, body });
    const queued = await queuedIn(be, message.header.room);
    if (bool(ctx, "json")) {
      json({ ...messageToJson(message), delivery: queued === null ? "pushed" : "queued" });
      return 0;
    }
    if (queued === null) out(green("✓ answered") + dim(` ${message.header.id}`));
    else reportDelivery(message.header.id, queued);
    return 0;
  });
}

/**
 * What to do when a thread hits its reply budget.
 *
 * The failure this prevents: agents treated a parked thread as finished and
 * opened a new one, splitting a single incident across two and discarding the
 * context. One human message in the SAME thread refills the budget.
 */
function replyBudgetHint(thread: string): string {
  return (
    yellow("  this thread hit its reply budget") +
    `\n  ${dim("do NOT open a new thread — that splits the work and loses the context")}` +
    `\n  ${dim("one human reply in this thread refills it:")}` +
    `\n    ${bold(`oguri answer <id> "<their words>" --as-human`)}` +
    `\n  ${dim(`thread ${thread}`)}`
  );
}
