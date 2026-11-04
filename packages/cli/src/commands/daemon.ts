import { daemonInstall, daemonStart, daemonStatus, daemonStop } from "../daemon-cmd.ts";
import { dim, errline, green, json, out, yellow } from "../output.ts";

import { type Ctx, bool, usage } from "../context.ts";

export async function cmdDaemon(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "status";
  switch (sub) {
    case "status": {
      const status = await daemonStatus(ctx.layout);
      if (bool(ctx, "json")) {
        json(status);
        return status.running ? 0 : 1;
      }
      out(
        status.running
          ? green("● running") + dim(` · ${status.socket}`)
          : yellow("○ not running") + dim(` · ${status.socket}`),
      );
      out(
        `supervisor ${status.supervisor}${status.serviceInstalled ? green(" · unit installed") : dim(" · no unit")}`,
      );
      if (status.unit !== null) out(dim(`unit       ${status.unit}`));
      if (!status.running) {
        out();
        out(dim("start it:   oguri daemon start"));
        out(dim("or at login: oguri daemon install"));
      }
      return status.running ? 0 : 1;
    }
    case "start": {
      const result = await daemonStart(ctx.layout);
      out(result.started ? green(`✓ ${result.message}`) : yellow(result.message));
      return result.started || result.message === "already running" ? 0 : 1;
    }
    case "stop": {
      const result = await daemonStop(ctx.layout);
      out(result.stopped ? green(`✓ ${result.message}`) : yellow(result.message));
      return result.stopped || result.message === "not running" ? 0 : 1;
    }
    case "install": {
      for (const line of await daemonInstall()) out(line);
      return 0;
    }
    case "uninstall": {
      for (const line of await (await import("../daemon-cmd.ts")).daemonUninstall()) out(line);
      return 0;
    }
    case "run": {
      // Foreground: what the supervisor unit actually executes.
      const { Daemon } = await import("@oguri/daemon");
      const daemon = new Daemon({ layout: ctx.layout, log: (l) => errline(l) });
      await daemon.start();
      await new Promise<void>(() => {
        /* run until signalled */
      });
      return 0;
    }
    default:
      usage(`unknown 'daemon' subcommand: ${sub}`);
  }
}
