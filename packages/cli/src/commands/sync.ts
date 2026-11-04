import { json, out, red, yellow } from "../output.ts";

import { type Ctx, bool } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdSync(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const report = await be.call<{
      roomsPolled: number;
      changed: unknown[];
      recorded: number;
      delivered: number;
      anomalies: { status: string; path: string }[];
      unreadable: unknown[];
    }>("sync");
    if (bool(ctx, "json")) {
      json(report);
      return 0;
    }
    out(
      `polled ${String(report.roomsPolled)} room(s) · ` +
        `${String(report.changed.length)} changed · ` +
        `${String(report.recorded)} new message(s) · ` +
        `${String(report.delivered)} delivered to inbox`,
    );
    if (report.anomalies.length > 0) {
      out(
        red(
          `⚠ ${String(report.anomalies.length)} protocol anomaly/anomalies (modified or deleted messages):`,
        ),
      );
      for (const a of report.anomalies.slice(0, 5)) out(red(`  ${a.status} ${a.path}`));
    }
    if (report.unreadable.length > 0) {
      out(yellow(`⚠ ${String(report.unreadable.length)} unreadable message file(s)`));
    }
    return 0;
  });
}
