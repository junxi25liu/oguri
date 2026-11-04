import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describeError } from "@oguri/core";

const exec = promisify(execFile);

export type SupervisorKind = "launchd" | "systemd" | "unsupported";

export const SERVICE_LABEL = "dev.oguri.daemon";

/**
 * One user service: what it is called and how it is described to the platform.
 *
 * The daemon and the worker are installed the same way and differ only in
 * these fields, so both go through one implementation. Every function below
 * defaults to the daemon's spec, which keeps its unit names unchanged.
 */
export interface ServiceSpec {
  /** launchd label, also the plist file name. */
  label: string;
  /** systemd user unit file name. */
  unit: string;
  description: string;
  /** launchd writes `<logName>.out.log` and `<logName>.err.log` under `~/.oguri/logs`. */
  logName: string;
  /** What to tell a person on a platform with no supported supervisor. */
  manual: string;
  /** Environment the service runs with. Neither launchd nor systemd inherits the user's shell. */
  env?: Readonly<Record<string, string>>;
}

export const DAEMON_SERVICE: ServiceSpec = {
  label: SERVICE_LABEL,
  unit: "oguri.service",
  description: "oguri daemon",
  logName: "daemon",
  manual: "Run 'ogurid' yourself, or use a scheduled task.",
};

export function detectSupervisor(): SupervisorKind {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return "unsupported";
}

export function unitPath(kind: SupervisorKind, spec: ServiceSpec = DAEMON_SERVICE): string {
  if (kind === "launchd") return join(homedir(), "Library", "LaunchAgents", `${spec.label}.plist`);
  if (kind === "systemd") return join(homedir(), ".config", "systemd", "user", spec.unit);
  throw new Error(`no supervisor integration for ${process.platform}`);
}

/**
 * Note the absence of any privileged install path.
 *
 * The daemon runs as the user, unprivileged, under the platform's own user-level
 * supervisor — never as a system service. It needs the user's git credentials
 * and home directory, and nothing more; requiring root to run a chat client
 * would be a smell.
 */
export function renderUnit(
  kind: SupervisorKind,
  execPath: string,
  args: readonly string[],
  spec: ServiceSpec = DAEMON_SERVICE,
): string {
  const logDir = join(homedir(), ".oguri", "logs");
  const env = Object.entries(spec.env ?? {});

  if (kind === "launchd") {
    const programArgs = [execPath, ...args]
      .map((a) => `    <string>${escapeXml(a)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
${
  env.length === 0
    ? ""
    : `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`).join("\n")}
  </dict>
`
}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(logDir, `${spec.logName}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDir, `${spec.logName}.err.log`))}</string>
</dict>
</plist>
`;
  }

  if (kind === "systemd") {
    return `[Unit]
Description=${spec.description}
Documentation=https://github.com/junxi25liu/oguri
After=network-online.target

[Service]
Type=simple
${env.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`).join("")}ExecStart=${[execPath, ...args].map(shellQuote).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  }

  throw new Error(`no supervisor integration for ${process.platform}`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A double-quoted systemd value; `%` is a specifier there and must be doubled. */
function systemdQuote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface InstallResult {
  kind: SupervisorKind;
  path: string;
  started: boolean;
  hint: string;
}

export async function installService(
  execPath: string,
  args: readonly string[],
  spec: ServiceSpec = DAEMON_SERVICE,
): Promise<InstallResult> {
  const kind = detectSupervisor();
  if (kind === "unsupported") {
    throw new Error(`automatic startup is not supported on ${process.platform}. ${spec.manual}`);
  }

  const path = unitPath(kind, spec);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderUnit(kind, execPath, args, spec), "utf8");

  let started = false;
  let hint = "";
  try {
    if (kind === "launchd") {
      // `bootout` first so a re-install replaces a running agent rather than
      // failing with "service already loaded".
      await exec("launchctl", [
        "bootout",
        `gui/${String(process.getuid?.() ?? 0)}/${spec.label}`,
      ]).catch(() => undefined);
      await exec("launchctl", ["bootstrap", `gui/${String(process.getuid?.() ?? 0)}`, path]);
      started = true;
      hint = `launchctl bootout gui/$(id -u)/${spec.label}   # to stop`;
    } else {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", spec.unit]);
      started = true;
      hint = `systemctl --user status ${spec.unit}`;
    }
  } catch (error) {
    hint = `unit written to ${path}, but starting it failed: ${describeError(error)}`;
  }

  return { kind, path, started, hint };
}

export async function uninstallService(
  spec: ServiceSpec = DAEMON_SERVICE,
): Promise<{ kind: SupervisorKind; removed: boolean }> {
  const kind = detectSupervisor();
  if (kind === "unsupported") return { kind, removed: false };
  const path = unitPath(kind, spec);

  try {
    if (kind === "launchd") {
      await exec("launchctl", ["bootout", `gui/${String(process.getuid?.() ?? 0)}/${spec.label}`]);
    } else {
      await exec("systemctl", ["--user", "disable", "--now", spec.unit]);
    }
  } catch {
    // Already stopped, or never started — removing the unit still matters.
  }

  let removed = false;
  try {
    await unlink(path);
    removed = true;
  } catch {
    removed = false;
  }
  if (kind === "systemd")
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  return { kind, removed };
}

export async function isServiceInstalled(spec: ServiceSpec = DAEMON_SERVICE): Promise<boolean> {
  const kind = detectSupervisor();
  if (kind === "unsupported") return false;
  try {
    await readFile(unitPath(kind, spec), "utf8");
    return true;
  } catch {
    return false;
  }
}
