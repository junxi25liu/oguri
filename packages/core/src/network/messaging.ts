/**
 * Writing to a room: sending, forecasting who a send will reach, and answering.
 *
 * The message format is `@oguri/protocol` and the room log is `../room/store.ts`;
 * this is the half that guards a write — subscription, secrets, the reply
 * budget, signing — and then commits and pushes it.
 */

import {
  MENTION_ROOM,
  createMessage,
  machineFromToken,
  roomRef,
  ulid,
  type AuthorKind,
  type Claim,
  type ExternalRef,
  type Message,
  type MessageKind,
  type Needs,
  type Priority,
  type RelayPurpose,
  type ReviewTask,
  type Task,
} from "@oguri/protocol";

import { agentsOnMachine, expandMachineMentions, type AgentCard } from "../agent/card.ts";
import { ReplyBudgetExceededError, SecretDetectedError } from "../errors.ts";
import { FileLock } from "../lock.ts";
import { DEFAULT_ROOM_POLICY, type RoomConfig } from "../room/config.ts";
import {
  assessReviewDiscussionPressure,
  assessThreadPressure,
  type ThreadPressure,
} from "../room/pressure.ts";
import { RoomStore } from "../room/store.ts";
import { scanForSecrets, type SecretRule } from "../scanner/secrets.ts";
import { signMessage } from "../authenticity.ts";
import { activeTaskThreads } from "../task/tasks.ts";
import type { AuthenticityMode } from "../net.ts";
import type { Repo } from "../git/repo.ts";
import type { StateDb } from "../state.ts";
import { conciseFailure } from "./sync.ts";

const REMOTE = "origin";

export interface SendInput {
  body: string;
  kind?: MessageKind;
  needs?: Needs;
  mentions?: string[];
  priority?: Priority;
  tags?: string[];
  refs?: string[];
  review?: ReviewTask;
  task?: Task;
  claim?: Claim;
  /** The outside message this one relays, such as a person's Feishu message (ADR 0030). */
  external?: ExternalRef;
  /** Why this message should go back to its task's origin conversation (ADR 0030). */
  relay?: RelayPurpose;
  inReplyTo?: string;
  thread?: string;
  authorKind?: AuthorKind;
  /** Override a secret-scanner block. Recorded permanently in the header. */
  forceUnsafe?: string;
}

/**
 * Whether a mention will actually reach the agent it names.
 *
 * Three answers, and the distinction between the last two is the whole point:
 * an agent that publishes no subscription list is `unknown`, NOT `no`. Older
 * clients do not publish one, and reporting a confident "they will not see
 * this" about a peer who is reading fine would be worse than saying nothing.
 */
export type DeliveryOutlook = "reaches" | "misses" | "unknown";

export interface DeliveryForecast {
  agent: string;
  outlook: DeliveryOutlook;
  /** Why, in one clause, for a human or an agent to relay. */
  reason: string;
}

/**
 * What a relay surface supplies before recording declared human provenance.
 *
 * A callback keeps the ordinary agent path separate from the explicit relay
 * flow. It is a workflow affordance, not authentication (ADR 0012).
 */
export interface HumanConfirmationRequest {
  messageId: string;
  room: string;
  from: string;
  question: string;
  answer: string;
}

export interface AnswerOptions {
  /** Relay confirmation, normally from the interactive CLI. This is not identity proof. */
  confirmHuman?: (request: HumanConfirmationRequest) => Promise<boolean>;
}

/** What writing to a room needs from the network, and nothing more. */
export interface MessagingContext {
  readonly agentId: string;
  readonly repo: Repo;
  readonly state: StateDb;
  readonly lockPath: string;
  assertSubscribed(roomId: string, verb: string): void;
  ensureRoomWorktree(roomId: string): Promise<string>;
  readRoomConfig(roomId: string): Promise<RoomConfig | null>;
  resolveMentions(mentions: readonly string[]): Promise<string[]>;
  authenticityMode(): Promise<AuthenticityMode>;
  signingKeyPath(): Promise<string | null>;
  listAgents(): Promise<AgentCard[]>;
}

export async function send(
  ctx: MessagingContext,
  roomId: string,
  input: SendInput,
  extraRules: readonly SecretRule[] = [],
): Promise<Message> {
  // Sending into a room you do not follow posts a question whose answer you
  // will never see: routing delivers replies only within subscriptions.
  ctx.assertSubscribed(roomId, "send to");
  return await FileLock.withLock(ctx.lockPath, async () => {
    const worktree = await ctx.ensureRoomWorktree(roomId);

    // Blocking, never advisory: git history is permanent, so a leaked
    // credential cannot be recalled (security and trust §3).
    const findings = scanForSecrets(input.body, { extraRules });
    if (findings.length > 0 && input.forceUnsafe === undefined) {
      throw new SecretDetectedError(findings);
    }

    const head = await ctx.repo.resolveRef(`refs/heads/${roomRef(roomId)}`);
    const id = ulid();

    // A reply joins its parent's thread. Without this every answer would open
    // a new thread, and `threadOrder` would render conversations as a flat
    // list of unrelated roots.
    let thread = input.thread;
    let existingMessages: Message[] | null = null;
    if (thread === undefined && input.inReplyTo !== undefined) {
      existingMessages = await new RoomStore(worktree, roomId).readAll(() => undefined);
      const parent = existingMessages.find((m) => m.header.id === input.inReplyTo);
      thread = parent?.header.thread ?? input.inReplyTo;
    }

    const authorKind = input.authorKind ?? "agent";
    const pressureEligible =
      input.task === undefined &&
      (input.review === undefined || input.review.state === "discussing");

    let pressure: ThreadPressure | null = null;
    if (authorKind === "agent" && thread !== undefined && pressureEligible) {
      const messages =
        existingMessages ?? (await new RoomStore(worktree, roomId).readAll(() => undefined));
      existingMessages = messages;
      // Discussion around unfinished task work is exempt.
      //
      // The budget exists to stop two agents ping-ponging with nothing to
      // show for it. A task thread already has a stronger bound — it must
      // reach `completed` or `cancelled`, and its silence deadline surfaces
      // it if it does not — so applying the generic budget here only splits
      // one engagement across several threads and loses the continuity that
      // long-running work depends on. The exemption ends when the task does.
      // The whole room, not just this thread: a task's state depends on the
      // tasks it depends on.
      if (!activeTaskThreads(messages).has(thread)) {
        const budget =
          (await ctx.readRoomConfig(roomId))?.policy.replyBudget ?? DEFAULT_ROOM_POLICY.replyBudget;
        pressure =
          input.review?.state === "discussing"
            ? assessReviewDiscussionPressure(messages, thread, input.review.id, budget)
            : assessThreadPressure(messages, thread, budget);
      }
    }
    // Hitting the budget REFUSES locally; it does not rewrite the message.
    //
    // It used to convert the agent's own message into a permanent
    // `needs: human` on the shared log — burning the one marker that is
    // supposed to mean "a person must decide this" on what was usually a
    // conversation that had merely gone on a while. A marker spent on routine
    // traffic stops meaning anything, and it is permanent. Refusing keeps the
    // record clean and still puts the decision in front of a person.
    if (pressure?.shouldPark === true) {
      throw new ReplyBudgetExceededError(
        roomId,
        thread as string,
        pressure.consecutiveAgentMessages,
      );
    }
    const needs = input.needs ?? "none";
    const tags = [...(input.tags ?? [])];
    const review = input.review;
    // A `machine:<id>` mention is expanded here, once, so every surface that
    // sends gets it and no caller has to know the roster. The token survives
    // alongside the ids it resolved to — see `expandMachineMentions` for why
    // dropping either half breaks a real case.
    const mentions =
      input.mentions === undefined ? undefined : await ctx.resolveMentions(input.mentions);

    const message = createMessage({
      id,
      room: roomId,
      from: ctx.agentId,
      authorKind,
      kind: input.kind ?? "msg",
      needs,
      body: input.body.endsWith("\n") ? input.body : `${input.body}\n`,
      ...(thread === undefined ? {} : { thread }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(mentions === undefined ? {} : { mentions }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(input.refs === undefined ? {} : { refs: input.refs }),
      ...(review === undefined ? {} : { review }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.claim === undefined ? {} : { claim: input.claim }),
      ...(input.external === undefined ? {} : { external: input.external }),
      ...(input.relay === undefined ? {} : { relay: input.relay }),
      ...(head === null ? {} : { seen: head }),
    });
    if (input.forceUnsafe !== undefined) {
      message.header.unsafeReason = input.forceUnsafe;
    }

    // Sign BEFORE writing: the canonical form excludes `sig`, so signing a
    // message already on disk would still produce the same bytes — but doing
    // it here keeps the file written exactly once.
    if ((await ctx.authenticityMode()) === "signed") {
      const keyPath = await ctx.signingKeyPath();
      if (keyPath === null) {
        throw new Error(
          "this network requires signed messages, but no SSH signing key was found. " +
            "Set one with: git config user.signingkey ~/.ssh/id_ed25519.pub",
        );
      }
      const signature = await signMessage(message, keyPath);
      if (signature === null) {
        throw new Error(`could not sign the message with ${keyPath}`);
      }
      message.header.sig = signature.trim();
    }

    const store = new RoomStore(worktree, roomId);
    const repoPath = await store.writeMessage(message);
    await ctx.repo.runner.run(["add", "--", repoPath], { cwd: worktree });
    await ctx.repo.runner.run(["commit", "--quiet", "-F", "-"], {
      cwd: worktree,
      input: `oguri: ${message.header.kind} in ${roomId}\n\n${message.header.id}\n`,
    });
    try {
      // A SHORT ladder on purpose. Inline retries are for push contention,
      // which clears in milliseconds; an actual outage is the outbox's job.
      // Walking the full ladder here would make a user wait a minute before
      // their offline message was even queued.
      await ctx.repo.pushWithRetry(worktree, roomRef(roomId), {
        remote: REMOTE,
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffCapMs: 1_000,
      });
      ctx.state.setMeta(`queuedSince:${roomId}`, "");
      ctx.state.setMeta(`queuedReason:${roomId}`, "");
    } catch (error) {
      // The commit is already durable, so a push that did not go through is
      // not a lost message — it is a queued one, and the next sync sends it.
      //
      // This used to rethrow anything that was not `PushExhaustedError`, on
      // the reasoning that an auth failure "needs a human". It does — but the
      // form that took was a raw `git ... push failed (128): Permission denied
      // (publickey)` presented as a failed send, for a message that was safe
      // and did go out on the next sync. A sender who believes that error
      // retries, and the duplicate is permanent. Naming the problem while
      // saying the message is safe serves the human better than an error that
      // implies data loss.
      ctx.state.setMeta(`queuedSince:${roomId}`, new Date().toISOString());
      ctx.state.setMeta(`queuedReason:${roomId}`, conciseFailure(error));
    }

    const newHead = await ctx.repo.runner.text(["rev-parse", "HEAD"], { cwd: worktree });
    ctx.state.setHead(roomId, newHead);
    return message;
  });
}

/**
 * Will a message mentioning these agents actually reach them?
 *
 * Routing delivers only within a recipient's subscriptions, so mentioning an
 * agent that never joined the room produced silence indistinguishable from
 * being ignored — a question could sit unanswered for a day with both sides
 * believing the other was slow. Cards now publish subscriptions, so this is
 * answerable before the mistake costs anything.
 *
 * Advisory in the positive direction and reliable in the negative: a peer may
 * have joined a second ago and not pushed, but a room missing from a card
 * that lists rooms is one they are very unlikely to be reading.
 */
export async function forecastDelivery(
  ctx: MessagingContext,
  roomId: string,
  agents: readonly string[],
): Promise<DeliveryForecast[]> {
  if (agents.length === 0) return [];
  const roster = await ctx.listAgents();
  const cards = new Map(roster.map((card) => [card.id, card]));

  // Forecast what will actually be sent, not what the caller typed: a machine
  // mention is expanded at send time, so forecasting the raw token would
  // report "unknown" for a message that reaches three agents.
  const expanded = expandMachineMentions(agents, roster);
  const empty: DeliveryForecast[] = expanded
    .filter((token) => machineFromToken(token) !== null)
    .filter((token) => agentsOnMachine(roster, machineFromToken(token) as string).length === 0)
    .map((token) => ({
      agent: token,
      outlook: "unknown" as const,
      reason:
        "no agent in this machine's copy of the roster claims that machine — either nothing " +
        "has registered there yet, or the machine id is wrong",
    }));

  return empty.concat(
    expanded
      .filter((agent) => machineFromToken(agent) === null)
      .filter((agent) => agent !== MENTION_ROOM && agent !== ctx.agentId)
      .map((agent) => {
        const card = cards.get(agent);
        if (card === undefined) {
          return {
            agent,
            outlook: "unknown" as const,
            // Deliberately not "check the spelling". The roster is this
            // machine's last-fetched copy of `main`, so a peer that registered
            // after the last sync is missing from it — and telling a sender
            // their correct id is wrong sends them hunting for a typo while the
            // message they just sent lands perfectly well.
            reason: "not in this machine's copy of the roster — either new, or the id is wrong",
          };
        }
        if (card.subscriptions === undefined) {
          return {
            agent,
            outlook: "unknown" as const,
            reason: "publishes no room list (older oguri), so delivery cannot be predicted",
          };
        }
        return card.subscriptions.includes(roomId)
          ? { agent, outlook: "reaches" as const, reason: `follows #${roomId}` }
          : {
              agent,
              outlook: "misses" as const,
              reason: `does not follow #${roomId}, so routing will not deliver this`,
            };
      }),
  );
}

/**
 * Answer a message.
 *
 * The ordinary agent-facing path refuses `needs: human`; the interactive CLI
 * can relay an answer with `author_kind: human`. That marker is cooperative
 * attribution, not proof of human presence: an agent and its human commonly
 * share the same OS identity and terminal capability (ADR 0012).
 */
export async function answer(
  ctx: MessagingContext,
  messageId: string,
  body: string,
  options: AnswerOptions = {},
): Promise<Message> {
  const item = ctx.state.listInbox({ includeProcessed: true }).find((i) => i.id === messageId);
  if (item === undefined) throw new Error(`no message ${messageId} in this agent's inbox`);

  let authorKind: AuthorKind = "agent";

  if (item.needs === "human") {
    if (options.confirmHuman === undefined) {
      throw new Error(
        `message ${messageId} is marked 'needs: human', so this direct agent path will not ` +
          `answer it. Surface it to a person, then relay their decision with ` +
          `'oguri answer ${messageId} "<their words>" --as-human'. Human attribution is ` +
          `cooperative, not identity proof.`,
      );
    }
    const confirmed = await options.confirmHuman({
      messageId: item.id,
      room: item.room,
      from: item.from,
      question: item.body,
      answer: body,
    });
    if (!confirmed) throw new Error("not recorded — the human did not confirm this answer");
    authorKind = "human";
  } else if (options.confirmHuman !== undefined) {
    // An ordinary message answered from the interactive path is still the
    // human speaking, and the record should say so.
    authorKind = (await options.confirmHuman({
      messageId: item.id,
      room: item.room,
      from: item.from,
      question: item.body,
      answer: body,
    }))
      ? "human"
      : "agent";
  }

  const sent = await send(ctx, item.room, {
    body,
    kind: "answer",
    needs: "none",
    inReplyTo: item.id,
    // Taken from the inbox row rather than re-read from the room: the parent
    // may already have been pruned out of the live window by a seal.
    thread: item.thread,
    mentions: [item.from],
    authorKind,
  });
  ctx.state.resolveHumanItem(item.id);
  return sent;
}
