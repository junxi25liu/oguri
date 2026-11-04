/**
 * What a superagent remembers between passes, on this machine only (ADR 0031).
 *
 * Nothing here is a source of truth: the transport repository is. The file
 * only stops a superagent from answering the same message twice or reporting
 * the same event twice after a restart.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A worker the big superagent deployed, and the conversation to tell about it. */
export interface Tracked {
  room: string;
  /** Where the owner asked. */
  conversation: {
    room: string;
    thread: string;
    messageId: string;
    author: string;
    /** The owner's language, for what code says when the worker moves. */
    lang?: "zh" | "en";
  };
  /** The last task event already told to the owner. */
  told?: string;
  /** A plan's step: told only when it needs the owner. */
  quiet?: boolean;
  /** The pull request the worker delivered, followed until it merges or closes. */
  pr?: string;
  prCheckedAt?: number;
  prDone?: boolean;
}

export interface SuperagentState {
  /** Messages already handled, by id. Bounded. */
  handled: string[];
  /** Messages before this time are history, not requests. Set on first start. */
  since: string;
  /** Workers the big superagent deployed, by task id. */
  tracked: Record<string, Tracked>;
  /** Situations already coordinated or reported, by key, with when. */
  noted: Record<string, number>;
  /** Requests the model did not answer, by first message id: tries so far (ADR 0033). */
  attempts: Record<string, number>;
  /** What the owner was told since the session's last turn, for its context. */
  notices: string[];
}

const MAX_HANDLED = 2000;
/** Notices kept for the next turn. */
export const MAX_NOTICES = 12;
/** Tries before a request the model never answered is given up, as a queued evaluation. */
export const MAX_ATTEMPTS = 3;

export function stateFile(home: string, role: "big" | "small"): string {
  return join(home, "superagent", `${role}.json`);
}

export async function readSuperagentState(
  home: string,
  role: "big" | "small",
  now: number,
): Promise<SuperagentState> {
  try {
    const raw = JSON.parse(
      await readFile(stateFile(home, role), "utf8"),
    ) as Partial<SuperagentState>;
    return {
      handled: Array.isArray(raw.handled) ? raw.handled.filter((id) => typeof id === "string") : [],
      since: typeof raw.since === "string" ? raw.since : new Date(now).toISOString(),
      tracked: typeof raw.tracked === "object" && raw.tracked !== null ? raw.tracked : {},
      noted: typeof raw.noted === "object" && raw.noted !== null ? raw.noted : {},
      attempts: typeof raw.attempts === "object" && raw.attempts !== null ? raw.attempts : {},
      notices: Array.isArray(raw.notices)
        ? raw.notices.filter((notice) => typeof notice === "string").slice(-MAX_NOTICES)
        : [],
    };
  } catch {
    return {
      handled: [],
      since: new Date(now).toISOString(),
      tracked: {},
      noted: {},
      attempts: {},
      notices: [],
    };
  }
}

export async function writeSuperagentState(
  home: string,
  role: "big" | "small",
  state: SuperagentState,
): Promise<void> {
  if (state.handled.length > MAX_HANDLED) state.handled = state.handled.slice(-MAX_HANDLED);
  const path = stateFile(home, role);
  await mkdir(join(home, "superagent"), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}
