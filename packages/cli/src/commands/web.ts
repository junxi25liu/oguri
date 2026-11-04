import { listRuns } from "@oguri/worker";
import { openBackend } from "@oguri/daemon";

import { type Ctx, bool, num, str, usage } from "../context.ts";
import { bold, dim, green, out, yellow } from "../output.ts";
import { ReadOnlyBackend } from "../web/data.ts";
import {
  DEFAULT_WEB_PORT,
  dashboardUrl,
  planBind,
  startDashboard,
  type BindPlan,
} from "../web/server.ts";

/**
 * `oguri web` — a read-only dashboard on this machine (ADR 0028).
 *
 * Serves one page and a few JSON endpoints over the same `Backend` the other
 * commands use. Its reads are passive: an open tab does not count as an agent
 * at the keyboard, so it neither keeps the sync cadence hot nor silences the
 * notification for a direct mention.
 */
export async function cmdWeb(ctx: Ctx): Promise<number> {
  let plan: BindPlan;
  try {
    const host = str(ctx, "host");
    const token = str(ctx, "token");
    plan = planBind({
      ...(host === undefined ? {} : { host }),
      port: num(ctx, "port") ?? DEFAULT_WEB_PORT,
      allowRemote: bool(ctx, "allow-remote"),
      ...(token === undefined ? {} : { token }),
    });
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }

  const network = str(ctx, "network");
  const backend = await openBackend({
    layout: ctx.layout,
    ...(network === undefined ? {} : { network }),
    ...(bool(ctx, "direct") ? { forceDirect: true } : {}),
    passive: true,
  });
  const home = ctx.layout.root;
  let started;
  try {
    started = await startDashboard({
      backend: new ReadOnlyBackend(backend),
      listRuns: async (limit) => await listRuns(home, limit),
      plan,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    await backend.close();
    throw error;
  }

  const url = dashboardUrl(plan, started.port);
  out(`${green("oguri web")} ${bold(url)} ${dim(`(read-only, ${backend.mode} mode)`)}`);
  if (plan.generated) {
    out(yellow("serving beyond loopback: every API request needs this bearer token"));
    out(`  token ${bold(plan.token ?? "")}`);
  }
  if (backend.mode === "direct") {
    out(dim("no daemon: each refresh may pull from the remote; 'oguri daemon start' avoids that"));
  }
  out(dim("Ctrl-C to stop"));

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  started.server.closeAllConnections();
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
  await backend.close();
  return 0;
}
