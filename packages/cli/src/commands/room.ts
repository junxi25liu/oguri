import { assertRoomId } from "@oguri/protocol";
import { ago, bold, dim, errline, green, json, out, red, yellow } from "../output.ts";

import { type Ctx, bool, num, str, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdRoom(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";
  const roomId = ctx.positionals[2];

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "list": {
        const rooms =
          await be.call<{ id: string; title: string; subscribed: boolean; pending: number }[]>(
            "rooms",
          );
        if (bool(ctx, "json")) {
          json(rooms);
          return 0;
        }
        if (rooms.length === 0) {
          out(dim("no rooms yet — create one: oguri room create <name>"));
          return 0;
        }
        for (const r of rooms) {
          const mark = r.subscribed ? green("●") : dim("○");
          const pending = r.pending > 0 ? yellow(` ${String(r.pending)} pending`) : "";
          out(`${mark} ${bold(r.id.padEnd(20))} ${dim(r.title)}${pending}`);
        }
        return 0;
      }
      case "create": {
        if (roomId === undefined) usage("room create needs a name");
        assertRoomId(roomId);
        const title = str(ctx, "title");
        const purpose = str(ctx, "purpose");
        // Settable only at creation: room.yaml is shared, and an agent may
        // rewrite only its own card, profile, and receipts (ADR 0004).
        const replyBudget = num(ctx, "reply-budget");
        await be.call("roomCreate", {
          room: roomId,
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
          ...(replyBudget === undefined ? {} : { replyBudget }),
        });
        out(green(`✓ created room ${roomId} and subscribed`));
        if (replyBudget !== undefined) {
          out(dim(`  reply budget ${String(replyBudget)} — threads park for a person after that`));
        }
        return 0;
      }
      case "join": {
        if (roomId === undefined) usage("room join needs a name");
        await be.call("roomJoin", { room: assertRoomId(roomId) });
        out(green(`✓ joined ${roomId}`));
        return 0;
      }
      case "leave": {
        if (roomId === undefined) usage("room leave needs a name");
        await be.call("roomLeave", { room: assertRoomId(roomId) });
        out(green(`✓ left ${roomId}`));
        return 0;
      }
      case "show": {
        if (roomId === undefined) usage("room show needs a name");
        const room = await be.call<{
          id: string;
          title: string;
          purpose: string;
          status: string;
          created: string;
          createdBy: string;
          retention: { windowDays: number; windowMessages: number };
        } | null>("roomShow", { room: assertRoomId(roomId) });
        if (room === null) {
          errline(red(`no such room: ${roomId}`));
          return 1;
        }
        if (bool(ctx, "json")) json(room);
        else {
          out(`${bold(room.title)} ${dim(`(${room.id})`)}`);
          if (room.purpose !== "") out(room.purpose);
          out(dim(`status ${room.status} · created ${ago(room.created)} by ${room.createdBy}`));
          out(
            dim(
              `window ${String(room.retention.windowDays)}d / ${String(room.retention.windowMessages)} msgs`,
            ),
          );
        }
        return 0;
      }
      default:
        usage(`unknown 'room' subcommand: ${sub}`);
    }
  });
}
