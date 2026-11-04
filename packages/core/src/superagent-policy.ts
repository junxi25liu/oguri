/**
 * The `superagent` section of the machine-local policy (ADR 0031).
 *
 * oguri as a personal tool: one big superagent you talk to, which coordinates
 * a small superagent on each of your machines. You can also talk to any small
 * superagent directly. Everything they say and do is a message in the
 * transport repository, so every agent on every machine reads the same record.
 *
 * Both roles are off by default, like the worker and intake.
 */

import { isAgentId, isRoomId } from "@oguri/protocol";

export interface BigSuperagentPolicy {
  /** Run the big superagent on this machine. One machine in a network should. */
  enabled: boolean;
  /** The room you talk to the superagents in. Created on first start. */
  room: string;
  /** The room the big superagent creates tasks in. Defaults to `room`. */
  workRoom?: string;
  /** An entry of `worker.runners` the big superagent thinks with. Defaults to `worker.plannerRunner`, then the default runner. */
  runner?: string;
  /** Seconds one decision may take. */
  timeoutSeconds: number;
  /** Act on the small superagents' reports: move a stuck task to another machine, or tell you. */
  coordinate: boolean;
  /** The GitHub CLI that follows a worker's pull request until it merges or closes. */
  githubCli: string;
}

export interface SmallSuperagentPolicy {
  /** Run a small superagent on this machine. Pair it with `worker.enabled` so it has hands. */
  enabled: boolean;
  /** The big superagent's agent id. Its tasks run here without `oguri task approve`. */
  big?: string;
  /** Answer when you talk to this machine directly. Uses the same runner rules as the big one. */
  talk: boolean;
  /** An entry of `worker.runners` this small superagent thinks with when you talk to it. */
  runner?: string;
  /**
   * How many workers may run on this machine at once while the small
   * superagent is on. It replaces `worker.concurrency`, so the small superagent
   * decides how many to deploy for a request, up to this.
   */
  maxWorkers: number;
  /** Minutes a task this machine holds may go without an event before it is reported. */
  quietMinutes: number;
  /** Minutes between two reports on the same quiet task. */
  reportEveryMinutes: number;
}

export interface SuperagentPolicy {
  big: BigSuperagentPolicy;
  small: SmallSuperagentPolicy;
}

export const DEFAULT_SUPERAGENT_ROOM = "superagent";

export const DEFAULT_SUPERAGENT_POLICY: SuperagentPolicy = {
  big: {
    enabled: false,
    room: DEFAULT_SUPERAGENT_ROOM,
    timeoutSeconds: 180,
    coordinate: true,
    githubCli: "gh",
  },
  small: { enabled: false, talk: true, maxWorkers: 3, quietMinutes: 30, reportEveryMinutes: 60 },
};

const SECTION_KEYS = ["big", "small"] as const;
const BIG_KEYS = [
  "enabled",
  "room",
  "workRoom",
  "runner",
  "timeoutSeconds",
  "coordinate",
  "githubCli",
] as const;
const SMALL_KEYS = [
  "enabled",
  "big",
  "talk",
  "runner",
  "maxWorkers",
  "quietMinutes",
  "reportEveryMinutes",
] as const;

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function mapping(value: unknown, at: string, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, `${at} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  entry: Record<string, unknown>,
  keys: readonly string[],
  at: string,
  source: string,
): void {
  for (const key of Object.keys(entry)) {
    if (!keys.includes(key)) {
      fail(source, `unknown key '${at}.${key}'; known keys: ${keys.join(", ")}`);
    }
  }
}

function bool(value: unknown, fallback: boolean, at: string, source: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(source, `${at} must be true or false`);
  return value;
}

function integer(
  value: unknown,
  fallback: number,
  range: [number, number],
  at: string,
  source: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < range[0] ||
    value > range[1]
  ) {
    fail(source, `${at} must be an integer from ${String(range[0])} to ${String(range[1])}`);
  }
  return value;
}

function name(value: unknown, at: string, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    fail(source, `${at} must be a non-empty string`);
  return value.trim();
}

function room(
  value: unknown,
  fallback: string | undefined,
  at: string,
  source: string,
): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !isRoomId(value)) fail(source, `${at} is not a valid room id`);
  return value;
}

function parseBig(value: unknown, source: string): BigSuperagentPolicy {
  const at = "superagent.big";
  const entry = mapping(value, at, source);
  onlyKeys(entry, BIG_KEYS, at, source);
  const defaults = DEFAULT_SUPERAGENT_POLICY.big;
  const workRoom = room(entry["workRoom"], undefined, `${at}.workRoom`, source);
  const runner = name(entry["runner"], `${at}.runner`, source);
  return {
    enabled: bool(entry["enabled"], defaults.enabled, `${at}.enabled`, source),
    room: room(entry["room"], defaults.room, `${at}.room`, source) as string,
    ...(workRoom === undefined ? {} : { workRoom }),
    ...(runner === undefined ? {} : { runner }),
    timeoutSeconds: integer(
      entry["timeoutSeconds"],
      defaults.timeoutSeconds,
      [10, 1800],
      `${at}.timeoutSeconds`,
      source,
    ),
    coordinate: bool(entry["coordinate"], defaults.coordinate, `${at}.coordinate`, source),
    githubCli: name(entry["githubCli"], `${at}.githubCli`, source) ?? defaults.githubCli,
  };
}

function parseSmall(value: unknown, source: string): SmallSuperagentPolicy {
  const at = "superagent.small";
  const entry = mapping(value, at, source);
  onlyKeys(entry, SMALL_KEYS, at, source);
  const defaults = DEFAULT_SUPERAGENT_POLICY.small;
  const big = name(entry["big"], `${at}.big`, source);
  if (big !== undefined && !isAgentId(big)) fail(source, `${at}.big must be an agent id`);
  const runner = name(entry["runner"], `${at}.runner`, source);
  return {
    enabled: bool(entry["enabled"], defaults.enabled, `${at}.enabled`, source),
    ...(big === undefined ? {} : { big }),
    talk: bool(entry["talk"], defaults.talk, `${at}.talk`, source),
    maxWorkers: integer(
      entry["maxWorkers"],
      defaults.maxWorkers,
      [1, 16],
      `${at}.maxWorkers`,
      source,
    ),
    ...(runner === undefined ? {} : { runner }),
    quietMinutes: integer(
      entry["quietMinutes"],
      defaults.quietMinutes,
      [1, 10080],
      `${at}.quietMinutes`,
      source,
    ),
    reportEveryMinutes: integer(
      entry["reportEveryMinutes"],
      defaults.reportEveryMinutes,
      [1, 10080],
      `${at}.reportEveryMinutes`,
      source,
    ),
  };
}

export function parseSuperagentPolicy(value: unknown, source: string): SuperagentPolicy {
  const section = mapping(value, "superagent", source);
  onlyKeys(section, SECTION_KEYS, "superagent", source);
  return {
    big:
      section["big"] === undefined
        ? { ...DEFAULT_SUPERAGENT_POLICY.big }
        : parseBig(section["big"], source),
    small:
      section["small"] === undefined
        ? { ...DEFAULT_SUPERAGENT_POLICY.small }
        : parseSmall(section["small"], source),
  };
}
