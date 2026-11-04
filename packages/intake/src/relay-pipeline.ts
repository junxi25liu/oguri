/**
 * One call per intake poll that moves replies toward the chat (ADR 0030 §6–§8).
 *
 * `tick` scans the rooms for owed replies, follows the pull requests tasks
 * reported, and flushes the outbox, in that order, so a reply found this tick
 * can go out this tick. Each step catches its own failures: a room that cannot
 * be read or a `gh` that is missing must not stop replies that are ready.
 */

import { reduceTasks, type IntakePolicy, type TaskUpdateInput } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import {
  followPrs,
  taskPrs,
  type GhRunner,
  type PrFollowReport,
  type TaskPrs,
} from "./github/pr-follow.ts";
import type { Outbox } from "./outbox/types.ts";
import { scanRelays, type RelayBackend, type ScanReport } from "./relay-scan.ts";

export interface RelayPipelineOptions {
  backend: RelayBackend;
  /** The rooms intake writes tasks into, read every tick. */
  rooms: () => readonly string[];
  outbox: Outbox;
  policy: () => IntakePolicy;
  stateDir: string;
  /** Where a room without a relay cursor starts; the pipeline's creation time by default. */
  since?: number;
  now?: () => number;
  runGh?: GhRunner;
}

export interface TickReport {
  scan: ScanReport;
  prs: PrFollowReport | null;
  /** Steps that threw, by name. */
  errors: { step: "scan" | "prs" | "flush"; error: string }[];
}

/** Adapt a `Backend` to the two calls relaying makes. */
export function relayBackend(backend: Backend, network?: string): RelayBackend {
  return {
    read: async (room) => await backend.call<Message[]>("read", { room }, network),
    completeTask: async (room, taskId, body, refs) => {
      const input: TaskUpdateInput = { action: "completed", body, refs };
      return await backend.call<Message>("taskUpdate", { room, taskId, input }, network);
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RelayPipeline {
  private readonly options: RelayPipelineOptions;
  private readonly now: () => number;
  private readonly since: number;

  constructor(options: RelayPipelineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.since = options.since ?? this.now();
  }

  async tick(signal?: AbortSignal): Promise<TickReport> {
    const { backend, outbox, stateDir } = this.options;
    const policy = this.options.policy();
    const rooms = [...new Set(this.options.rooms())];
    const report: TickReport = { scan: { replies: [], failed: [] }, prs: null, errors: [] };

    // One read per room serves both the scan and the PR follow.
    const read = new Map<string, Message[]>();
    const reader = {
      read: async (room: string): Promise<Message[]> => {
        const messages = await backend.read(room);
        read.set(room, messages);
        return messages;
      },
    };
    try {
      report.scan = await scanRelays(reader, rooms, this.since, {
        outbox,
        stateDir,
        maxReplyWords: policy.maxReplyWords,
        now: this.now,
      });
    } catch (error) {
      report.errors.push({ step: "scan", error: describe(error) });
    }

    if (policy.githubCli !== undefined && signal?.aborted !== true) {
      try {
        const now = this.now();
        const found: TaskPrs[] = [];
        for (const [room, messages] of read) {
          found.push(...taskPrs(room, messages, reduceTasks(messages, now)));
        }
        report.prs = await followPrs(found, {
          githubCli: policy.githubCli,
          outbox,
          stateDir,
          completeTask: backend.completeTask,
          now: this.now,
          ...(this.options.runGh === undefined ? {} : { runGh: this.options.runGh }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        report.errors.push({ step: "prs", error: describe(error) });
      }
    }

    if (signal?.aborted !== true) {
      try {
        await outbox.flush(signal);
      } catch (error) {
        report.errors.push({ step: "flush", error: describe(error) });
      }
    }
    return report;
  }
}
