import { ago, bold, cyan, dim, green, json, out, yellow } from "../output.ts";

import { type Ctx, bool, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdPresence(ctx: Ctx): Promise<number> {
  const declaring = bool(ctx, "live") || bool(ctx, "away");
  if (bool(ctx, "live") && bool(ctx, "away")) usage("pick one of --live or --away");

  return await withBackend(ctx, async (be) => {
    if (declaring) {
      const status = bool(ctx, "live") ? "live" : "away";
      const { published } = await be.call<{ published: boolean }>("announce", { status });
      if (bool(ctx, "json")) {
        json({ status, published });
        return 0;
      }
      out(
        published
          ? green(`✓ published presence: ${status}`)
          : dim(`already ${status} — nothing to publish`),
      );
      if (status === "live") {
        // Said plainly because the word "live" overclaims on its own: nothing
        // after this command keeps the assertion true. What was published is a
        // timestamp, and every reader ages it into an answer.
        out(dim("  this stamps 'seen now'; peers read live for 5m, then unknown, then away"));
      }
      return 0;
    }

    const rows = await be.call<
      {
        id: string;
        status: string;
        lastSeen: string;
        lastActivity?: string | null;
        human: string;
        timezone: string;
        sessions?: number;
      }[]
    >("presence");
    if (bool(ctx, "json")) {
      json(rows);
      return 0;
    }
    if (rows.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const r of rows) {
      const mark =
        r.status === "live"
          ? green("● live")
          : r.status === "stale"
            ? yellow("? stale")
            : dim("○ away");
      // Concurrent sessions are only worth showing when there is more than one:
      // the agent id is the participant, the count is how many windows are open.
      const concurrent = (r.sessions ?? 0) > 1 ? cyan(` ×${String(r.sessions)}`) : "";
      // Report both clocks only when they actually read differently. The card
      // is a declaration and the newest message is evidence; showing only the
      // declaration is what made a peer mid-task read as absent, but printing
      // both when they agree is noise on every ordinary row.
      const wrote = r.lastActivity == null ? null : ago(r.lastActivity);
      const declared = ago(r.lastSeen);
      const seen =
        wrote === null || wrote === declared || (r.lastActivity as string) <= r.lastSeen
          ? declared
          : `${wrote} (wrote) · card ${declared}`;
      out(
        `${mark}${concurrent}  ${bold(r.id.padEnd(20))} ` +
          dim(`${seen} · ${r.human} · ${r.timezone}`),
      );
    }
    if (be.mode !== "daemon") {
      out();
      out(
        dim(
          "no daemon: presence is stamped by 'oguri watch' and 'oguri handshake' while they run,\n" +
            "and ages to away on its own. For continuous presence: oguri daemon start",
        ),
      );
    }
    return 0;
  });
}
