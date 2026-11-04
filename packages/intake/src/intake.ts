/**
 * The intake loop (ADR 0030): read a chat, turn requests into tasks and
 * follow-ups into task-thread messages, and hand replies to the outbox.
 *
 * Intake is an ordinary agent identity and reaches oguri only through
 * `Backend`, like the worker. It starts nothing: a task it creates is run, or
 * not, by whichever worker the task's target and that worker's own policy
 * allow. One machine runs it per app, held by an advisory claim; a second one
 * started by mistake stays idle and says who holds the claim.
 */

import { describeError, type IntakePolicy, type TaskStatus } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { externalKey, type Message } from "@oguri/protocol";

import { admit } from "./admission.ts";
import { FeishuClient } from "./feishu/client.ts";
import { FeishuSource } from "./feishu/source.ts";
import type { Outbox } from "./outbox/types.ts";
import { followupMessage, taskRequest } from "./request.ts";
import type { InboundMessage, IntakeSource, SourceHealth } from "./source.ts";
import {
  findTask,
  linkTask,
  readIntakeState,
  rebuildTaskMap,
  relayedKeys,
  writeIntakeState,
  type IntakeStateData,
} from "./state.ts";

export interface IntakeOptions {
  backend: Backend;
  agentId: string;
  /** This agent's oguri home; state goes under `<home>/intake/`. */
  home: string;
  /** Read before every poll, so switching intake off needs no restart. */
  loadPolicy: () => Promise<IntakePolicy>;
  outbox: Outbox;
  /** Build the source for a policy. Defaults to the Feishu source. */
  createSource?: (policy: IntakePolicy, state: IntakeStateData) => IntakeSource;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PollReport {
  enabled: boolean;
  /** Why nothing was read: intake is off, or another machine holds the claim. */
  idle?: string;
  created: { room: string; taskId: string; message: string }[];
  relayed: { room: string; taskId: string; message: string; admitted: boolean }[];
  ignored: { message: string; reason: string }[];
  refused: { message: string; reason: string }[];
}

/** Attempts at writing one message before intake gives up on it and says so in the chat. */
const MAX_WRITE_ATTEMPTS = 3;
/** Error codes that a retry cannot fix. */
const PERMANENT_CODES = new Set([
  "SECRET_DETECTED",
  "MALFORMED_MESSAGE",
  "INVALID_IDENTIFIER",
  "INVALID_TASK_TRANSITION",
]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The claim one app's intake holds. Claim names allow `[a-z0-9._:/-]`, and app ids carry `_`. */
export function intakeResource(source: string, appId: string): string {
  return `intake:${source}:${appId.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
}

/** The rooms intake writes to, in policy order. */
export function intakeRooms(policy: IntakePolicy): string[] {
  const rooms = (policy.feishu?.chats ?? []).map((chat) => chat.room);
  if (policy.feishu?.directRoom !== undefined) rooms.push(policy.feishu.directRoom);
  return [...new Set(rooms)];
}

/** How long the claim lasts. Renewed at half-life, so a poll every few seconds is not a commit. */
export function claimTtlSeconds(policy: IntakePolicy): number {
  return Math.min(24 * 60 * 60, Math.max(10 * 60, (policy.feishu?.pollSeconds ?? 10) * 3));
}

/** What a person reads when intake could not take their request. Never the error text. */
export function refusalText(code: string | undefined, followup: boolean): string {
  const what = followup ? "pass this on to the task" : "start this task";
  if (code === "SECRET_DETECTED") {
    return `I could not ${what}: it looks like it contains a secret, and oguri never writes one down. Remove it and send it again.`;
  }
  return `I could not ${what}. The machine running intake logged why; ask its owner to check 'oguri intake status'.`;
}

export class Intake {
  private readonly options: IntakeOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private state: IntakeStateData | undefined;
  private source: IntakeSource | undefined;
  private sourceKey = "";
  private network = "";
  private rebuilt = false;
  /** The rooms last joined, so a chat added to the policy while running is joined too. */
  private joined = "";
  private readonly relayed = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private claimExpiresAt = 0;
  private claimResource: { resource: string; room: string } | undefined;

  constructor(options: IntakeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** The source's own report, once a poll has built it. */
  health(): SourceHealth | undefined {
    return this.source?.health();
  }

  private async loadState(): Promise<IntakeStateData> {
    if (this.state === undefined) {
      this.state = await readIntakeState(this.options.home);
      this.state.status = { startedAt: new Date(this.now()).toISOString(), pid: process.pid };
    }
    return this.state;
  }

  private sourceFor(policy: IntakePolicy, state: IntakeStateData): IntakeSource {
    const feishu = policy.feishu;
    // A different app is a different bot: its identity and chat details are not ours.
    if (feishu !== undefined && state.appId !== feishu.appId) {
      delete state.botId;
      delete state.botName;
      state.chats = {};
      state.appId = feishu.appId;
    }
    const key = JSON.stringify(feishu ?? null);
    if (this.source === undefined || key !== this.sourceKey) {
      this.sourceKey = key;
      this.source =
        this.options.createSource?.(policy, state) ??
        new FeishuSource({
          client: new FeishuClient({
            appId: feishu?.appId ?? "",
            appSecret: feishu?.appSecret ?? "",
            ...(feishu?.apiUrl === undefined ? {} : { apiUrl: feishu.apiUrl }),
          }),
          policy: feishu as NonNullable<IntakePolicy["feishu"]>,
          state,
          now: this.now,
          log: this.log,
        });
    }
    return this.source;
  }

  /**
   * Join the rooms intake writes to, then rebuild the task map and the dedupe
   * set from them. Runs once, before the first message is handled.
   */
  private async rebuild(policy: IntakePolicy, state: IntakeStateData): Promise<void> {
    const { backend } = this.options;
    await backend.call("sync").catch((error: unknown) => {
      this.log(`sync failed, using what is already local: ${describeError(error)}`);
    });
    const status = await backend.call<{ networkId: string; subscriptions: string[] }>("status");
    this.network = status.networkId;
    const rooms = intakeRooms(policy);
    for (const room of rooms) {
      if (!status.subscriptions.includes(room)) {
        await backend.call("roomJoin", { room });
        this.log(`joined room ${room}`);
      }
    }
    const listed: { room: string; tasks: TaskStatus[] }[] = [];
    for (const room of rooms) {
      listed.push({ room, tasks: await backend.call<TaskStatus[]>("tasks", { room }) });
      for (const key of relayedKeys(await backend.call<Message[]>("read", { room }), this.now())) {
        this.relayed.add(key);
      }
    }
    // The rooms are the truth; anything the file knew that they do not is dropped.
    state.tasks = rebuildTaskMap(listed, this.network);
    this.rebuilt = true;
  }

  /** Hold the intake claim, renewing it at half-life. Returns why intake must stay idle, or null. */
  private async holdClaim(policy: IntakePolicy, state: IntakeStateData): Promise<string | null> {
    const room = intakeRooms(policy)[0];
    const appId = policy.feishu?.appId;
    if (room === undefined || appId === undefined) return "no room to hold the intake claim in";
    const resource = intakeResource("feishu", appId);
    const ttl = claimTtlSeconds(policy);
    const mine = this.claimResource?.resource === resource && this.claimResource.room === room;
    if (mine && this.claimExpiresAt - this.now() > (ttl * 1000) / 2) return null;

    const result = await this.options.backend.call<{
      granted: boolean;
      status: { holder: string; expiresAt: string } | null;
    }>("claim", {
      room,
      resource,
      ttlSeconds: ttl,
      note: `intake for Feishu app ${appId} runs here`,
    });
    const holder = result.status?.holder ?? "nobody";
    state.status.claim = {
      resource,
      room,
      holder,
      mine: result.granted,
      at: new Date(this.now()).toISOString(),
    };
    if (!result.granted) {
      this.claimResource = undefined;
      return `${resource} is held by ${holder}; staying idle`;
    }
    this.claimResource = { resource, room };
    const expires = Date.parse(result.status?.expiresAt ?? "");
    this.claimExpiresAt = Number.isFinite(expires) ? expires : this.now() + ttl * 1000;
    return null;
  }

  /** Give the claim back, so another machine can take over at once. */
  async release(): Promise<void> {
    if (this.claimResource === undefined) return;
    const { resource, room } = this.claimResource;
    this.claimResource = undefined;
    this.claimExpiresAt = 0;
    if (this.state !== undefined) {
      delete this.state.status.claim;
      await writeIntakeState(this.options.home, this.state);
    }
    await this.options.backend
      .call("claimRelease", { room, resource })
      .catch((error: unknown) =>
        this.log(`could not release ${resource}: ${describeError(error)}`),
      );
  }

  /** One poll: read, admit, write, flush the outbox, persist. */
  async poll(signal?: AbortSignal): Promise<PollReport> {
    const policy = await this.options.loadPolicy();
    const state = await this.loadState();
    const report: PollReport = {
      enabled: policy.enabled,
      created: [],
      relayed: [],
      ignored: [],
      refused: [],
    };
    try {
      if (!policy.enabled || policy.feishu === undefined) {
        report.idle = "intake.enabled is false";
        await this.release();
        return report;
      }
      // Joining comes first: a claim is taken in a room, and only a subscriber may write there.
      const wanted = intakeRooms(policy).join("\n");
      if (!this.rebuilt || wanted !== this.joined) {
        await this.rebuild(policy, state);
        this.joined = wanted;
      }
      const idle = await this.holdClaim(policy, state);
      if (idle !== null) {
        report.idle = idle;
        return report;
      }

      const source = this.sourceFor(policy, state);
      const messages = await source.poll(signal);
      const handled: InboundMessage[] = [];
      // A conversation stops at its first message that could not be written,
      // so the next poll retries it before anything said after it.
      const stalled = new Set<string>();
      if (messages.length > 0) {
        await this.options.backend.call("sync").catch(() => undefined);
      }
      for (const message of messages) {
        if (signal?.aborted === true) break;
        const conversation = message.external.conversation ?? "";
        if (stalled.has(conversation)) continue;
        if (await this.handle(policy, state, message, report)) handled.push(message);
        else stalled.add(conversation);
      }
      await source.commit(handled);
      const health = source.health();
      if (health.lastError !== undefined) state.status.lastError = health.lastError;
      if (health.backoffUntil === undefined) delete state.status.backoffUntil;
      else state.status.backoffUntil = health.backoffUntil;
    } catch (error) {
      state.status.lastError = {
        at: new Date(this.now()).toISOString(),
        message: describeError(error),
      };
      this.log(`poll failed: ${describeError(error)}`);
    } finally {
      try {
        await this.options.outbox.flush(signal);
      } catch (error) {
        this.log(`outbox flush failed: ${describeError(error)}`);
      }
      state.status.lastPollAt = new Date(this.now()).toISOString();
      if (report.idle === undefined) delete state.status.idle;
      else state.status.idle = report.idle;
      await writeIntakeState(this.options.home, state);
    }
    return report;
  }

  /** Handle one message. False means "not yet": it comes back on the next poll. */
  private async handle(
    policy: IntakePolicy,
    state: IntakeStateData,
    message: InboundMessage,
    report: PollReport,
  ): Promise<boolean> {
    const key = externalKey(message.external);
    if (this.relayed.has(key)) return true;
    const link = findTask(state.tasks, [message.parent, message.root, message.external.thread]);
    const decision = admit(policy, message, link);

    if (decision.kind === "ignore") {
      // Every message in a busy chat is ignored; only the ones that asked are worth a line.
      if (message.addressed !== null) {
        this.log(
          `ignored ${message.external.id} from ${message.external.actor}: ${decision.reason}`,
        );
      }
      report.ignored.push({ message: message.external.id, reason: decision.reason });
      return true;
    }

    try {
      if (decision.kind === "followup") {
        const { taskRef } = decision;
        const tasks = await this.options.backend.call<TaskStatus[]>(
          "tasks",
          { room: taskRef.room },
          taskRef.network,
        );
        const status = tasks.find((t) => t.task.id === taskRef.taskId);
        await this.options.backend.call(
          "send",
          {
            room: taskRef.room,
            input: followupMessage(message, taskRef.threadRoot, status, decision.admitted),
          },
          taskRef.network,
        );
        this.relayed.add(key);
        report.relayed.push({
          room: taskRef.room,
          taskId: taskRef.taskId,
          message: message.external.id,
          admitted: decision.admitted,
        });
        this.log(`relayed ${message.external.id} into task ${taskRef.taskId}`);
        return true;
      }

      const created = await this.options.backend.call<Message>("taskCreate", {
        room: decision.room,
        input: taskRequest(message, decision),
      });
      const taskId = created.header.task?.id ?? created.header.id;
      linkTask(
        state.tasks,
        {
          message: message.external.id,
          ...(message.external.thread === undefined ? {} : { thread: message.external.thread }),
        },
        { network: this.network, room: decision.room, taskId, threadRoot: created.header.thread },
      );
      this.relayed.add(key);
      report.created.push({ room: decision.room, taskId, message: message.external.id });
      this.log(`created task ${taskId} in ${decision.room} for ${message.external.id}`);
      return true;
    } catch (error) {
      const code = errorCode(error);
      const tries = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, tries);
      if (
        !PERMANENT_CODES.has(code ?? "") &&
        !(error instanceof TypeError) &&
        tries < MAX_WRITE_ATTEMPTS
      ) {
        this.log(
          `could not write ${message.external.id} (try ${String(tries)}): ${describeError(error)}`,
        );
        return false;
      }
      this.attempts.delete(key);
      const reason = describeError(error);
      this.log(`refused ${message.external.id}: ${reason}`);
      report.refused.push({ message: message.external.id, reason });
      state.status.lastError = { at: new Date(this.now()).toISOString(), message: reason };
      await this.options.outbox.enqueue({
        key: `${key}:refused`,
        source: message.external.source,
        conversation: message.external.conversation ?? "",
        replyTo: message.external.id,
        text: refusalText(code, decision.kind === "followup"),
        purpose: "attention",
        ...(decision.kind === "followup" ? { taskId: decision.taskRef.taskId } : {}),
      });
      return true;
    }
  }
}
