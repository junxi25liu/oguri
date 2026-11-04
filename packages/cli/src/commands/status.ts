import { type AgendaCounts, type Attention, type TransportHealth } from "@oguri/core";
import { ago, bold, cyan, dim, green, json, out, red, yellow } from "../output.ts";

import { renderDegraded } from "./inbox.ts";
import { type Surroundings } from "./watch.ts";
import { type Ctx, bool, str } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdStatus(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const status = await be.call<{
      networkId: string;
      remote: string;
      agentId: string;
      subscriptions: string[];
      pending: number;
      pendingHuman: number;
      lastSyncAt: string | null;
      tasks?: AgendaCounts;
      attention?: Attention;
      surroundings?: Surroundings;
      health?: TransportHealth;
      daemon?: { sessionLive: boolean; cadence: string; sessions: number };
    }>("status");
    if (bool(ctx, "json")) {
      json({ ...status, mode: be.mode });
      return 0;
    }
    out(`${bold(status.networkId)} ${dim(status.remote)}`);
    // The home, not just the id: "which identity am I" is a question about
    // which OGURI_HOME this invocation resolved to.
    out(
      `agent      ${status.agentId}` +
        dim(
          ` · ${ctx.layout.root}` +
            (process.env["OGURI_HOME"] === undefined
              ? process.env["OGURI_AGENT"] === undefined
                ? str(ctx, "agent") === undefined
                  ? " (default home)"
                  : " (--agent)"
                : " (OGURI_AGENT)"
              : " (OGURI_HOME)"),
        ),
    );
    out(`rooms      ${status.subscriptions.join(", ") || dim("none")}`);
    out(
      `pending    ${String(status.pending)}${
        status.pendingHuman > 0 ? red(` (${String(status.pendingHuman)} need a human)`) : ""
      }`,
    );
    // Split the pending count by whether it bears on the work in hand. Without
    // this the only way to find out was to open the inbox, and opening the
    // inbox is the context switch the reader was trying to decide about.
    const attention = status.attention;
    if (attention !== undefined && attention.interrupting.length > 0) {
      const reasons = [...new Set(attention.interrupting.map((i) => i.reason))].join(", ");
      out(
        `attention  ${yellow(`${String(attention.interrupting.length)} worth stopping for`)} ` +
          dim(`(${reasons})`) +
          (attention.deferred > 0 ? dim(` · ${String(attention.deferred)} can wait`) : ""),
      );
    }
    // Unread messages were the only thing status reported, so an agent could
    // read "nothing waiting" while owning work that had stalled for a week.
    const tasks = status.tasks;
    if (tasks !== undefined) {
      const owed = tasks.assigned + tasks.offered;
      out(
        `tasks      ${String(owed)} owed${
          tasks.unclaimed > 0 ? dim(` · ${String(tasks.unclaimed)} unclaimed`) : ""
        }${
          tasks.needsAttention > 0
            ? yellow(` · ${String(tasks.needsAttention)} need attention`)
            : ""
        }` + (owed + tasks.unclaimed > 0 ? dim("  (oguri task agenda)") : ""),
      );
    }
    // What is going on that this agent is not part of. An agent in one room
    // reads "pending 0" and concludes the network is quiet, when the team may
    // have started somewhere else entirely — and nothing ever said so.
    const around = status.surroundings;
    if (around !== undefined && (around.rooms.length > 0 || around.threads.length > 0)) {
      const parts = [
        around.rooms.length === 0
          ? null
          : `${String(around.rooms.length)} room(s) you have not joined: ${around.rooms.slice(0, 4).join(", ")}`,
        around.threads.length === 0
          ? null
          : `${String(around.threads.length)} conversation(s) started without you`,
      ].filter((part) => part !== null);
      out(`elsewhere  ${cyan(parts.join(" · "))}`);
      out(dim(`           oguri room list · oguri room join <id>`));
    }
    out(
      `last sync  ${status.lastSyncAt === null ? red("never") : ago(status.lastSyncAt)}` +
        (status.health?.degraded === true ? red("  · DEGRADED") : ""),
    );
    if (status.health?.degraded === true) out(renderDegraded(status.health));
    out(
      `daemon     ${
        be.mode === "daemon"
          ? green(`running · cadence ${status.daemon?.cadence ?? "?"}`) +
            dim(` · ${String(status.daemon?.sessions ?? 0)} session(s)`)
          : yellow("not running — delivery is pull-based (oguri sync)")
      }`,
    );
    return 0;
  });
}
