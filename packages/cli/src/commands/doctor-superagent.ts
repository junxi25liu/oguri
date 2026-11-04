/**
 * The superagent half of `oguri doctor`.
 *
 * Every failure here is silent by construction. A runner is an argv a person
 * wrote by hand in `policy.yaml`; when its first word is not on PATH, nothing
 * validates it until a worker or a superagent tries to start it — which is
 * usually unobserved, because those run unattended. Likewise a session file is
 * parsed by code that swallows its own errors (`SessionStore.read` falls back
 * to a fresh session), so a truncated file reads as "no context yet" rather
 * than as damage.
 *
 * Kept out of `doctor.ts` so it can be tested without a network, a remote, or a
 * daemon: every input is the policy, the home directory, and PATH.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

import {
  GitRunner,
  describeError,
  type Layout,
  type LocalPolicy,
  loadLocalPolicy,
  type WorkerRunner,
} from "@oguri/core";
import { expandHome } from "@oguri/worker";

export interface Finding {
  level: "ok" | "warn" | "bad";
  message: string;
  /** What to do about it. Required for `bad`, the fix `warn` suggests. */
  hint?: string;
}

export interface DoctorEnv {
  policy: LocalPolicy;
  /** Usually `layout.root`: `~/.oguri`, or an agent's home. */
  home: string;
  /** The PATH a runner started by the daemon would see. Defaults to this process's. */
  pathEnv?: string;
}

/** Resolve a command the way a shell would, without running it. */
async function commandOnPath(command: string, pathEnv: string): Promise<boolean> {
  const executable = async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // A path is used as written; only a bare name is searched for on PATH.
  if (command.includes("/") || command.includes("\\")) return await executable(command);
  for (const dir of pathEnv.split(delimiter)) {
    if (dir !== "" && (await executable(join(dir, command)))) return true;
  }
  return false;
}

/** The one field both roles share for this check. */
interface RunnerNaming {
  runner?: string;
}

/** The runner a role would think with, by the same fallbacks `resolveThinker` uses. */
function runnerNameFor(policy: LocalPolicy, role: RunnerNaming): string | undefined {
  const names = Object.keys(policy.worker.runners);
  return role.runner ?? policy.worker.plannerRunner ?? policy.worker.defaultRunner ?? names[0];
}

async function runnerFindings(
  policy: LocalPolicy,
  pathEnv: string,
  report: (finding: Finding) => void,
): Promise<void> {
  const { big, small } = policy.superagent;
  const roles: { at: string; role: RunnerNaming; enabled: boolean }[] = [
    { at: "superagent.big", role: big, enabled: big.enabled },
    { at: "superagent.small", role: small, enabled: small.enabled },
  ];

  // A role that is off starts nothing, so having no runner at all is fine.
  // A runner it *names*, though, is still checked: a typo there is silent
  // until the day the role is switched on, which is the worst moment to
  // discover it.
  const live = roles.filter(({ role, enabled }) => enabled || role.runner !== undefined);
  const checkedCommands = new Map<string, boolean>();
  for (const { at, role } of live) {
    const name = runnerNameFor(policy, role);
    if (name === undefined) {
      report({
        level: "bad",
        message: `${at} is enabled but no runner is configured`,
        hint:
          "add one under worker.runners in policy.yaml (see 'oguri policy --init'), " +
          `then set ${at}.runner to its name`,
      });
      continue;
    }
    const runner: WorkerRunner | undefined = policy.worker.runners[name];
    if (runner === undefined) {
      report({
        level: "bad",
        message: `${at} names runner '${name}', which is not in worker.runners`,
        hint: `define worker.runners.${name}, or point ${at}.runner at one of: ${Object.keys(policy.worker.runners).join(", ") || "none configured"}`,
      });
      continue;
    }
    const [command] = runner.argv;
    if (command === undefined) continue; // The parser refuses an empty argv already.
    // Big and small usually share a runner; probing PATH once per command
    // keeps doctor to one filesystem walk per distinct command.
    let present = checkedCommands.get(command);
    if (present === undefined) {
      present = await commandOnPath(command, pathEnv);
      checkedCommands.set(command, present);
    }
    if (present) {
      report({ level: "ok", message: `${at} runner '${name}': '${command}' is on PATH` });
    } else {
      report({
        level: "bad",
        message: `${at} runner '${name}': the command '${command}' is not on PATH`,
        hint: `install '${command}', or put its absolute path in worker.runners.${name}.argv[0]. The daemon starts runners with the PATH it inherited, which is often smaller than your shell's`,
      });
    }
  }
}

/**
 * `worktree: true` makes the worker run `git worktree add` in this directory,
 * so a directory that is not a repository fails at claim time — after the task
 * has been accepted and counted, which is why doctor should catch it first.
 */
async function worktreeFindings(
  policy: LocalPolicy,
  report: (finding: Finding) => void,
): Promise<void> {
  const checked = new Set<string>();
  for (const [name, runner] of Object.entries(policy.worker.runners)) {
    if (!runner.worktree) continue;
    const raw = runner.workdir ?? policy.worker.workdir;
    if (raw === undefined) {
      // The parser already refuses this combination, so reaching it means the
      // policy was built in memory. Say it rather than checking "~".
      report({
        level: "bad",
        message: `runner '${name}' sets worktree: true but names no repository`,
        hint: "set its workdir, or worker.workdir",
      });
      continue;
    }
    const dir = expandHome(raw);
    if (checked.has(dir)) continue;
    checked.add(dir);
    try {
      const { stdout } = await new GitRunner().run(["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
      });
      if (stdout.trim() === "true") {
        report({ level: "ok", message: `worktree base ${dir} is a git repository` });
      } else {
        report({
          level: "bad",
          message: `worktree base ${dir} is not a git work tree`,
          hint: "point worker.workdir (or the runner's workdir) at a normal clone, not a bare repository",
        });
      }
    } catch (error) {
      report({
        level: "bad",
        message: `worktree base ${dir} is not a git repository — ${describeError(error)}`,
        hint: "point worker.workdir (or the runner's workdir) at a clone; worktree: true runs 'git worktree add' there",
      });
    }
  }
}

/**
 * A damaged session file is not fatal — `SessionStore.read` falls back to a
 * fresh session — but it silently throws away the conversation the person is
 * paying to keep, so it is worth a warning with the one-line fix.
 */
async function sessionFindings(home: string, report: (finding: Finding) => void): Promise<void> {
  const dir = join(home, "superagent");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // No session has ever been kept on this machine.
  }
  for (const entry of entries.filter((name) => name.endsWith("-session.json")).sort()) {
    const path = join(dir, entry);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not a JSON object");
      }
      report({ level: "ok", message: `${entry} is readable` });
    } catch (error) {
      report({
        level: "warn",
        message: `${path} is damaged — ${describeError(error)}`,
        hint: `delete it; the superagent starts a fresh session (the conversation history in git is untouched): rm ${JSON.stringify(path)}`,
      });
    }
  }
}

/** Everything the superagent checks would say, in printing order. */
export async function superagentFindings(env: DoctorEnv): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pathEnv = env.pathEnv ?? process.env["PATH"] ?? "";
  await runnerFindings(env.policy, pathEnv, (f) => findings.push(f));
  await worktreeFindings(env.policy, (f) => findings.push(f));
  await sessionFindings(env.home, (f) => findings.push(f));
  return findings;
}

/**
 * Print the findings through doctor's three reporters.
 *
 * Loading the policy is part of the check: a file the parser refuses is a
 * fault doctor used to skip entirely, and every runner rule below is unknown
 * until it loads.
 */
export async function checkSuperagentDoctor(
  layout: Layout,
  ok: (message: string) => void,
  warn: (message: string, hint: string) => void,
  bad: (message: string, fix: string) => void,
): Promise<void> {
  let policy: LocalPolicy;
  try {
    policy = (await loadLocalPolicy(layout)).policy;
  } catch (error) {
    bad(
      `policy.yaml cannot be used — ${describeError(error)}`,
      "fix the file, then run doctor again",
    );
    return;
  }
  for (const finding of await superagentFindings({ policy, home: layout.root })) {
    if (finding.level === "ok") ok(finding.message);
    else if (finding.level === "warn") warn(finding.message, finding.hint ?? "");
    else bad(finding.message, finding.hint ?? "");
  }
}
