import { type Message, assertRoomId } from "@oguri/protocol";
import { ago, bold, dim, green, json, messageToJson, out, yellow } from "../output.ts";

import { type Ctx, bool, list, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

interface HandshakeReport {
  room: string;
  thread: string;
  message: Message;
  role: "open" | "ack";
  addressed: string[];
  peers: { id: string; status: string; lastSeen: string; tool: string; human: string }[];
  presencePublished: boolean;
  synced: boolean;
}

/**
 * First contact, as one command.
 *
 * The steps it folds together — announce, join, sync, greet, report who is
 * around — are each trivial and were each easy to forget, which is what made
 * getting two agents talking a conversation between two humans.
 *
 * It does not wait. The last thing it prints is the exact `oguri watch`
 * invocation for this thread, because the calling agent runs that as a
 * background monitor and is woken when the reply lands.
 */
export async function cmdHandshake(ctx: Ctx): Promise<number> {
  const isAck = ctx.positionals[1] === "ack";
  const target = ctx.positionals[isAck ? 2 : 1];
  const note = ctx.positionals.slice(isAck ? 3 : 2).join(" ");
  const peers = list(ctx, "peer");

  if (target === undefined) {
    usage(
      isAck
        ? "handshake ack needs a message id: oguri handshake ack <message-id>"
        : "handshake needs a room: oguri handshake <room> [note]",
    );
  }
  if (!isAck) assertRoomId(target);

  return await withBackend(ctx, async (be) => {
    const report = await be.call<HandshakeReport>("handshake", {
      input: {
        ...(isAck ? { ackTo: target } : { room: target }),
        ...(note === "" ? {} : { note }),
        ...(peers.length > 0 && !isAck ? { peers } : {}),
      },
    });

    if (bool(ctx, "json")) {
      json({ ...report, message: messageToJson(report.message), watch: watchHint(report) });
      return 0;
    }

    out(
      report.role === "ack"
        ? green("✓ handshake acknowledged") + dim(` ${report.message.header.id}`)
        : green("✓ handshake sent") + dim(` ${report.message.header.id}`),
    );
    out(`room       #${report.room}`);
    out(`thread     ${report.thread}`);
    out(`addressed  ${report.addressed.join(", ")}`);
    out(
      `presence   ${report.presencePublished ? green("stamped live") : dim("already live")}` +
        (be.mode === "daemon" ? "" : yellow(" · no daemon: it ages to away in ~10m")),
    );
    if (!report.synced) {
      out(yellow("offline    queued — it goes out on the next successful sync"));
    }

    out();
    if (report.peers.length === 0) {
      out(dim("no other agents have registered on this network yet"));
    } else {
      for (const peer of report.peers) {
        const mark =
          peer.status === "live"
            ? green("● live")
            : peer.status === "stale"
              ? yellow("? stale")
              : dim("○ away");
        out(`${mark}  ${bold(peer.id.padEnd(20))} ${dim(`${ago(peer.lastSeen)} · ${peer.tool}`)}`);
      }
      if (!report.peers.some((peer) => peer.status === "live")) {
        out(dim("nobody is live — the reply may take hours. Do not wait on it."));
      }
    }

    if (report.role === "open") {
      out();
      out("watch for the reply:");
      out(`  ${bold(watchHint(report))}`);
    }
    return 0;
  });
}

function watchHint(report: HandshakeReport): string {
  return `oguri watch --thread ${report.thread}`;
}
