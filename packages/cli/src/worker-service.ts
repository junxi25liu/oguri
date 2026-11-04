import type { Layout } from "@oguri/core";

import { selfScript } from "./self-script.ts";
import {
  type ServiceSpec,
  detectSupervisor,
  installService,
  isServiceInstalled,
  uninstallService,
  unitPath,
} from "@oguri/daemon";

/**
 * The worker as a user service, so it starts at login (ADR 0026).
 *
 * Installed through the daemon's supervisor code with its own names. One unit
 * per agent: a machine can host several agents (ADR 0023), each with its own
 * home and its own policy, and each worker must act as exactly one of them.
 */

/** Set in the unit, so `worker start` knows a supervisor will restart it on failure. */
export const SERVICE_ENV = "OGURI_WORKER_SERVICE";

export function workerService(agentId: string, layout: Layout): ServiceSpec {
  return {
    label: `dev.oguri.worker.${agentId}`,
    unit: `oguri-worker-${agentId}.service`,
    description: `oguri worker for ${agentId}`,
    logName: `worker-${agentId}`,
    manual: "Run 'oguri worker start' yourself, or use a scheduled task.",
    env: {
      // Pins the identity: a service has no shell, and with several agents
      // provisioned an unpinned worker would refuse to guess who it is.
      OGURI_HOME: layout.root,
      // launchd and systemd start services with a minimal PATH, and runners
      // are usually commands found on the user's own PATH.
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      [SERVICE_ENV]: "1",
    },
  };
}

/**
 * How to launch this CLI again, as a pure function of what this process is.
 *
 * The same three shapes as the daemon entry: a workspace checkout runs
 * `node …/cli/dist/bin.js`, a packaged binary runs itself, and anything else
 * falls back to `oguri` on PATH.
 */
export function cliEntryFor(
  execPath: string,
  argv1: string | undefined,
): { command: string; args: string[] } {
  // A workspace checkout (`…/bin.js`) or the npm package's single bundle
  // (`…/oguri.cjs`): run the same file with the same node.
  if (
    argv1 !== undefined &&
    (/(?:^|[/\\])bin\.js$/.test(argv1) || /(?:^|[/\\])oguri\.cjs$/.test(argv1))
  ) {
    return { command: execPath, args: [argv1] };
  }
  const leaf = execPath.split(/[/\\]/).pop() ?? execPath;
  if (!/^node(\.exe)?$/i.test(leaf)) return { command: execPath, args: [] };
  return { command: "oguri", args: [] };
}

export interface WorkerServiceStatus {
  supervisor: string;
  installed: boolean;
  unit: string | null;
}

export async function workerServiceStatus(
  agentId: string,
  layout: Layout,
): Promise<WorkerServiceStatus> {
  const supervisor = detectSupervisor();
  const spec = workerService(agentId, layout);
  return {
    supervisor,
    installed: await isServiceInstalled(spec),
    unit: supervisor === "unsupported" ? null : unitPath(supervisor, spec),
  };
}

export async function workerInstall(agentId: string, layout: Layout): Promise<string[]> {
  const { command, args } = cliEntryFor(process.execPath, selfScript());
  const result = await installService(
    command,
    [...args, "worker", "start"],
    workerService(agentId, layout),
  );
  return [
    `${result.started ? "installed and started" : "installed"} via ${result.kind}`,
    `unit: ${result.path}`,
    ...(result.hint === "" ? [] : [result.hint]),
  ];
}

export async function workerUninstall(agentId: string, layout: Layout): Promise<string[]> {
  const result = await uninstallService(workerService(agentId, layout));
  return [result.removed ? `removed the ${result.kind} unit` : `no ${result.kind} unit to remove`];
}
