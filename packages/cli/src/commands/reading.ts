import { type Message, assertRoomId } from "@oguri/protocol";
import {
  ago,
  bold,
  cyan,
  dim,
  errline,
  green,
  json,
  messageToJson,
  out,
  red,
  renderMessages,
  yellow,
} from "../output.ts";

import { type Ctx, bool, num, str, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdRead(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("read needs a room");
  assertRoomId(roomId);
  const thread = str(ctx, "thread");

  return await withBackend(ctx, async (be) => {
    const messages = await be.call<Message[]>("read", {
      room: roomId,
      limit: num(ctx, "limit") ?? 50,
      ...(thread === undefined ? {} : { thread }),
    });
    if (bool(ctx, "json")) json(messages.map(messageToJson));
    else renderMessages(messages);
    return 0;
  });
}

export async function cmdHistory(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("history needs a room");
  assertRoomId(roomId);
  const since = str(ctx, "since");
  const limit = num(ctx, "limit");

  return await withBackend(ctx, async (be) => {
    const messages = await be.call<Message[]>("history", {
      room: roomId,
      ...(since === undefined ? {} : { since }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (bool(ctx, "json")) json(messages.map(messageToJson));
    else renderMessages(messages);
    return 0;
  });
}

/**
 * What a room has settled, rather than what it has said.
 *
 * `decide` has always written to the permanent record, but nothing read it
 * back: once a seal pruned the live window, the decision existed only as a file
 * on the record branch that no command would show. So the property the design
 * sells — decisions outlive compaction — was true on disk and unobservable from
 * any surface. This closes that, and merges the sealed record with the
 * decisions still live so the answer does not change shape at seal time.
 */
export async function cmdDecisions(ctx: Ctx): Promise<number> {
  const room = ctx.positionals[1];
  if (room === undefined) usage("decisions needs a room");
  const limit = num(ctx, "limit");
  const includeSuperseded = bool(ctx, "all");

  return await withBackend(ctx, async (be) => {
    const decisions = await be.call<RoomDecisionRow[]>("decisions", {
      room,
      ...(limit === undefined ? {} : { limit }),
      ...(includeSuperseded ? { includeSuperseded: true } : {}),
    });
    if (bool(ctx, "json")) {
      json(decisions);
      return 0;
    }
    if (decisions.length === 0) {
      out(dim(`no decisions recorded in ${room} — 'oguri decide ${room} "<title>"' records one`));
      return 0;
    }
    for (const decision of decisions) {
      const seq = decision.seq === null ? "live" : `#${String(decision.seq).padStart(4, "0")}`;
      // Sealed vs live is the load-bearing distinction: only the sealed one is
      // safe from the next compaction, so it is shown on every row.
      const durability = decision.sealed ? green("sealed") : yellow("not yet sealed");
      out(`${cyan(seq)} ${bold(decision.title)} ${durability}`);
      out(dim(`  ${decision.decidedBy} · ${ago(decision.decidedAt)} · ${decision.sourceMessage}`));
      if (decision.supersededBy !== null) {
        out(dim(`  superseded by ${decision.supersededBy}`));
      }
    }
    return 0;
  });
}

export async function cmdSearch(ctx: Ctx): Promise<number> {
  const query = ctx.positionals.slice(1).join(" ");
  if (query === "") usage("search needs a query");
  const room = str(ctx, "room");

  return await withBackend(ctx, async (be) => {
    const hits = await be.call<{ room: string; message: Message }[]>("search", {
      query,
      ...(room === undefined ? {} : { room }),
      limit: num(ctx, "limit") ?? 20,
    });
    if (bool(ctx, "json")) {
      json(hits.map((h) => ({ room: h.room, ...messageToJson(h.message) })));
      return 0;
    }
    if (hits.length === 0) {
      out(dim("no matches in the live window — try 'oguri history <room>' to search deeper"));
      return 0;
    }
    for (const { room: r, message } of hits) {
      const line = message.body
        .trim()
        .split("\n")
        .find((l) => l.toLowerCase().includes(query.toLowerCase()));
      out(`${cyan(r)} ${bold(message.header.from)} ${dim(ago(message.header.ts))}`);
      out(`  ${line ?? message.body.trim().split("\n")[0] ?? ""}`);
      out(dim(`  ${message.header.id}`));
    }
    return 0;
  });
}

/**
 * Where one message actually got to.
 *
 * "Sent" answered the narrowest possible question — this machine wrote a
 * commit — and everything a sender actually wanted to know was scattered across
 * four other commands, so nobody assembled it. An unread message and an ignored
 * one looked identical, which is the state this exists to end.
 */
export async function cmdTrace(ctx: Ctx): Promise<number> {
  const messageId = ctx.positionals[1];
  if (messageId === undefined) usage("trace needs a message id");

  return await withBackend(ctx, async (be) => {
    const trace = await be.call<TraceRow | null>("trace", { messageId });
    if (trace === null) {
      errline(red(`✗ no message ${messageId} in the rooms this agent follows`));
      errline(dim("  trace reads the live window of subscribed rooms; try 'oguri sync' first"));
      return 1;
    }
    if (bool(ctx, "json")) {
      json(trace);
      return 0;
    }

    out(`${bold(trace.id)} ${dim(`#${trace.room} · from ${trace.from} · needs:${trace.needs}`)}`);
    out(`  ${green("✓")} stored    ${dim("committed here — durable, cannot be lost")}`);
    out(
      trace.pushed
        ? `  ${green("✓")} pushed    ${dim("on the remote; every peer can fetch it")}`
        : `  ${yellow("⧗")} pushed    ${yellow("not on the remote yet")} ${dim("— oguri sync")}`,
    );
    if (trace.recipients.length === 0) {
      out(`  ${dim("· addressed to nobody in particular — nothing to await")}`);
      return 0;
    }
    for (const who of trace.recipients) {
      // Ordered weakest to strongest, and each line says only what it knows:
      // a receipt means an agent processed its inbox, never that it understood.
      const state = !routableYes(who)
        ? red("will NOT arrive — they do not follow this room")
        : who.answered
          ? green("answered")
          : who.read
            ? cyan(`read${who.readAt === undefined ? "" : ` ${ago(who.readAt)}`}`)
            : yellow("not read yet");
      out(`  ${who.agent.padEnd(20)} ${state}`);
    }
    out();
    out(
      dim("read = their receipt covers this id (an agent processed it, not that a model agreed)."),
    );
    return 0;
  });
}

/** `unknown` counts as routable: an older peer publishes no room list. */
function routableYes(who: { routable: string }): boolean {
  return who.routable !== "no";
}

/** One row of `oguri decisions`, mirroring core's RoomDecision over IPC. */
interface RoomDecisionRow {
  seq: number | null;
  title: string;
  decidedBy: string;
  decidedAt: string;
  sourceMessage: string;
  supersedes: string | null;
  supersededBy: string | null;
  body: string;
  sealed: boolean;
  path: string | null;
}

interface TraceRow {
  id: string;
  room: string;
  thread: string;
  from: string;
  needs: string;
  stored: boolean;
  pushed: boolean;
  recipients: {
    agent: string;
    routable: string;
    read: boolean;
    readAt?: string;
    answered: boolean;
  }[];
}

interface ReceiptRow {
  agent: string;
  room: string;
  readThrough: string | null;
  count: number;
  updatedAt: string;
}

/**
 * Who has read what, in one room.
 *
 * The question this answers — "did anyone actually receive that?" — had no
 * answer before. `seen` in a message header looks like a read receipt and is
 * not: it is the transport commit the AUTHOR had observed when writing.
 */
export async function cmdReceipts(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("receipts needs a room: oguri receipts <room>");
  assertRoomId(roomId);
  const since = str(ctx, "reply-to");

  return await withBackend(ctx, async (be) => {
    const rows = await be.call<ReceiptRow[]>("receipts", { room: roomId });
    if (bool(ctx, "json")) {
      json(
        since === undefined
          ? rows
          : rows.map((row) => ({
              ...row,
              read: row.readThrough !== null && row.readThrough >= since,
            })),
      );
      return 0;
    }
    if (rows.length === 0) {
      out(dim(`no read receipts in #${roomId} yet`));
      out(dim("  an agent publishes one when it drains its inbox for the room"));
      return 0;
    }
    for (const row of rows) {
      // ULIDs sort chronologically, so comparing ids IS comparing time.
      const mark =
        since === undefined
          ? " "
          : row.readThrough !== null && row.readThrough >= since
            ? green("✓")
            : yellow("·");
      out(
        `${mark} ${bold(row.agent.padEnd(20))} ${dim(
          `read ${String(row.count)} · through ${row.readThrough ?? "nothing"} · ${ago(row.updatedAt)}`,
        )}`,
      );
    }
    if (since !== undefined) {
      out();
      out(dim("✓ means that agent processed a message at least as new as --reply-to."));
      out(dim("  It is only meaningful if the message was actually routed to them."));
    }
    return 0;
  });
}

/**
 * Messages naming this agent in rooms it does not follow.
 *
 * Routing works within subscriptions, so "addressed to you" is quietly weaker
 * than it sounds: a mention in a room you never joined reaches nothing. This is
 * the explicit question, kept out of `sync` because folding it in would fetch
 * every room on the network on every poll (ADR 0008).
 */
export async function cmdMentions(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const found =
      await be.call<
        { room: string; id: string; from: string; ts: string; needs: string; kind: string }[]
      >("mentions");
    if (bool(ctx, "json")) {
      json(found);
      return 0;
    }
    if (found.length === 0) {
      out(dim("nothing addressed to you in rooms you do not follow"));
      return 0;
    }
    const rooms = new Set<string>();
    for (const item of found) {
      rooms.add(item.room);
      out(
        `${cyan(item.room.padEnd(16))} ${bold(item.from.padEnd(18))} ` +
          `${item.needs === "human" ? red("needs:human") : dim(`needs:${item.needs}`)}  ${dim(ago(item.ts))}`,
      );
      out(dim(`  ${item.id}`));
    }
    out();
    out(`${String(found.length)} mention(s) in ${String(rooms.size)} room(s) you have not joined.`);
    for (const room of rooms) out(dim(`  oguri room join ${room}`));
    return 0;
  });
}
