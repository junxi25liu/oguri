import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isTaskCapability, type Message } from "@oguri/protocol";

import type { AgentCard } from "./agent/card.ts";
import type {
  AgentDirectoryEntry,
  AgentProfile,
  AgentProfileUpdate,
  AgentRuntimeEnvironment,
} from "./agent/profile.ts";
import type { ReadReceipt } from "./agent/receipt.ts";
import { ApprovalStore, type ApprovalKind, type ApprovalRecord } from "./approvals.ts";
import type { AgentIdentity, MachineIdentity, NetworkConfig } from "./config.ts";
import { NotSubscribedError } from "./errors.ts";
import { loadLocalPolicy, type ResolvedPolicy } from "./policy.ts";
import { GitRunner } from "./git/runner.ts";
import { Repo } from "./git/repo.ts";
import { Layout } from "./layout.ts";
import { type RoomConfig } from "./room/config.ts";
import type { ReviewTaskStatus } from "./review/tasks.ts";
import type { Agenda } from "./task/agenda.ts";
import { type TaskDetail, type TaskStatus } from "./task/tasks.ts";
import { type ClaimStatus } from "./room/claims.ts";
import * as claims from "./network/claims.ts";
import type { ClaimsContext } from "./network/claims.ts";
import * as reading from "./network/reading.ts";
import type { ReadingContext } from "./network/reading.ts";
import * as reviews from "./network/reviews.ts";
import * as sealing from "./network/sealing.ts";
import * as rooms from "./network/rooms.ts";
import * as agents from "./network/agents.ts";
import * as tasks from "./network/tasks.ts";
import * as delivery from "./network/delivery.ts";
import type { DeliveryContext, MessageTrace } from "./network/delivery.ts";
import * as discovery from "./network/discovery.ts";
import type { DiscoveredMention } from "./network/discovery.ts";
import * as waiting from "./network/waiting.ts";
import type { WaitForInboxOptions, WaitForInboxResult } from "./network/waiting.ts";
import type {
  AgendaRequest,
  ResumePoint,
  TaskCreateInput,
  TaskUpdateInput,
  TasksContext,
} from "./network/tasks.ts";
import * as approvals from "./network/approvals.ts";
import type { ApprovalsContext } from "./network/approvals.ts";
import type { AgentsContext, MachineAgentRow, MachineRow, PresenceRow } from "./network/agents.ts";
import type { RoomInfo, RoomsContext } from "./network/rooms.ts";
import * as inboxOps from "./network/inbox.ts";
import type { InboxContext } from "./network/inbox.ts";
import * as outboxOps from "./network/outbox.ts";
import type { OutboxContext, OutboxEntry } from "./network/outbox.ts";
import type { SealingContext } from "./network/sealing.ts";
import * as authenticity from "./network/authenticity.ts";
import type { AuthenticityContext } from "./network/authenticity.ts";
import type { ReviewRequestInput, ReviewUpdateInput, ReviewsContext } from "./network/reviews.ts";
import * as messaging from "./network/messaging.ts";
import type {
  AnswerOptions,
  DeliveryForecast,
  MessagingContext,
  SendInput,
} from "./network/messaging.ts";
import * as handshakes from "./network/handshake.ts";
import type { HandshakeContext, HandshakeInput, HandshakeResult } from "./network/handshake.ts";
import * as syncing from "./network/sync.ts";
import type { SyncContext, SyncReport, TransportHealth } from "./network/sync.ts";
import * as statusOps from "./network/status.ts";
import type { NetworkStatus, StatusContext, Surroundings } from "./network/status.ts";
import * as bootstrap from "./network/bootstrap.ts";
import { exists } from "./fs.ts";
import type { SecretRule } from "./scanner/secrets.ts";
import type { AuthenticityMode, NetManifest } from "./net.ts";
import type { SealDecision, SealResult } from "./seal/sealer.ts";
import { StateDb, type InboxItem, type InboxQuery } from "./state.ts";

// Moved into `./network/*` with the code that owns them, and re-exported here so
// nothing that imports them from this module has to change.
export type {
  AnswerOptions,
  DeliveryForecast,
  DeliveryOutlook,
  HumanConfirmationRequest,
  SendInput,
} from "./network/messaging.ts";
export type { HandshakeInput, HandshakePeer, HandshakeResult } from "./network/handshake.ts";
export type {
  RoomDiscovery,
  StoredThreadStart,
  SyncReport,
  ThreadStart,
  TransportHealth,
} from "./network/sync.ts";
export { conciseFailure } from "./network/sync.ts";
export type { NetworkStatus, Surroundings } from "./network/status.ts";
export type { PresenceRow } from "./network/agents.ts";
export type { DiscoveredMention } from "./network/discovery.ts";
export type { MessageTrace, TraceRecipient } from "./network/delivery.ts";
export type { OutboxEntry } from "./network/outbox.ts";
export type { ReviewRequestInput, ReviewUpdateInput } from "./network/reviews.ts";
export type { RoomInfo } from "./network/rooms.ts";
export type {
  AgendaRequest,
  ResumePoint,
  TaskCreateInput,
  TaskUpdateInput,
} from "./network/tasks.ts";
export type { WaitForInboxOptions, WaitForInboxResult } from "./network/waiting.ts";
export { MAX_WAIT_MS, MIN_WAIT_MS, clampWaitMs } from "./network/waiting.ts";

/**
 * One network, on this machine.
 *
 * Operates in **direct mode** (ADR 0005): every mutating call takes an
 * exclusive lock and runs git itself. The daemon will reuse these same methods
 * behind its socket — the logic lives here precisely so CLI and daemon cannot
 * drift apart.
 */
export class Network {
  readonly layout: Layout;
  readonly config: NetworkConfig;
  readonly identity: AgentIdentity;
  readonly repo: Repo;
  readonly state: StateDb;

  private constructor(init: {
    layout: Layout;
    config: NetworkConfig;
    identity: AgentIdentity;
    repo: Repo;
    state: StateDb;
  }) {
    this.layout = init.layout;
    this.config = init.config;
    this.identity = init.identity;
    this.repo = init.repo;
    this.state = init.state;
  }

  get id(): string {
    return this.config.id;
  }

  private get lockPath(): string {
    return join(this.layout.networkDir(this.id), "lock");
  }

  /** Work a person has agreed this agent may take on. Local, never published. */
  get approvals(): ApprovalStore {
    return new ApprovalStore(this.layout.approvalsPath(this.id));
  }

  /**
   * Machine-local policy, re-read rather than cached.
   *
   * A person edits this file expecting the next command to obey it; caching it
   * for the life of a daemon would mean tightening the rules had no effect
   * until a restart, which is the wrong way round for a control.
   */
  async policy(): Promise<ResolvedPolicy> {
    return await loadLocalPolicy(this.layout);
  }

  private get recordWorktree(): string {
    return this.layout.recordWorktree(this.id);
  }

  static open(
    layout: Layout,
    config: NetworkConfig,
    identity: AgentIdentity,
    runner: GitRunner = new GitRunner(),
  ): Network {
    return new Network({
      layout,
      config,
      identity,
      repo: new Repo(layout.gitDir(config.id), runner),
      state: StateDb.open(layout.statePath(config.id)),
    });
  }

  /**
   * Clone (or adopt) a transport repository and register this agent on it.
   *
   * Handles the empty-remote case explicitly, because that is the normal state
   * of a private repo someone just created for their team.
   */
  static async init(options: {
    layout: Layout;
    networkId: string;
    remote: string;
    identity: AgentIdentity;
    runner?: GitRunner;
  }): Promise<{ network: Network; createdNetwork: boolean }> {
    return await bootstrap.init({ construct: (init) => new Network(init) }, options);
  }

  /**
   * Publish (or refresh) this agent's card on `main`. Own file only.
   *
   * Returns whether anything was actually pushed — presence is published on
   * transition, and the caller uses this to avoid logging a no-op.
   */
  private get agentsContext(): AgentsContext {
    return {
      identity: this.identity,
      subscriptions: this.config.subscriptions,
      repo: this.repo,
      recordWorktree: this.recordWorktree,
      lockPath: this.lockPath,
      gitIdentity: async () => await this.gitIdentity(),
      read: async (roomId) => await this.read(roomId),
    };
  }

  async publishAgentCard(
    extras: {
      expertise?: string[];
      speaksFor?: string[];
      presence?: "live" | "away";
      session?: string;
    } = {},
  ): Promise<boolean> {
    return await agents.publishAgentCard(this.agentsContext, extras);
  }

  async listAgents(): Promise<AgentCard[]> {
    return await agents.listAgents(this.agentsContext);
  }

  /** Publish this agent's cooperative description on `main`. Own file only. */
  async publishAgentProfile(
    update: AgentProfileUpdate = {},
    runtime?: AgentRuntimeEnvironment,
  ): Promise<boolean> {
    return await agents.publishAgentProfile(this.agentsContext, update, runtime);
  }

  async getAgentProfile(agentId = this.identity.id): Promise<AgentProfile | null> {
    return await agents.getAgentProfile(this.agentsContext, agentId);
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    return await agents.listAgentProfiles(this.agentsContext);
  }

  /** Cards with the scan-friendly role, preserving every existing card field. */
  async listAgentDirectory(): Promise<AgentDirectoryEntry[]> {
    return await agents.listAgentDirectory(this.agentsContext);
  }

  /** The roster, with presence corrected by observed activity. */
  async presenceRoster(): Promise<PresenceRow[]> {
    return await agents.presenceRoster(this.agentsContext);
  }

  // ----------------------------------------------------------------- machines

  /** The computer this agent runs on. Cooperative, never authenticated. */
  get machine(): MachineIdentity {
    return this.identity.machine;
  }

  /** The roster grouped by computer, this machine first. */
  async machines(): Promise<MachineRow[]> {
    return await agents.machineRoster(this.agentsContext);
  }

  /** The other agents on this computer — the ones that can share a checkout. */
  async peers(): Promise<MachineAgentRow[]> {
    return await agents.localPeers(this.agentsContext);
  }

  /** Mentions with every `machine:<id>` token expanded to the agents on it. */
  async resolveMentions(mentions: readonly string[]): Promise<string[]> {
    return await agents.resolveMentions(this.agentsContext, mentions);
  }

  /** The room the agents on this computer share, created and joined on demand. */
  async machineRoom(): Promise<{ room: string; created: boolean; joined: boolean }> {
    return await rooms.machineRoom(this.roomsContext);
  }

  // -------------------------------------------------------------------- rooms

  private get roomsContext(): RoomsContext {
    return {
      networkId: this.id,
      agentId: this.identity.id,
      machine: this.identity.machine,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      config: this.config,
      recordWorktree: this.recordWorktree,
      lockPath: this.lockPath,
      publishAgentCard: async () => await this.publishAgentCard(),
    };
  }

  async listRooms(): Promise<RoomInfo[]> {
    return await rooms.listRooms(this.roomsContext);
  }

  /** Create a room: an orphan branch for its log, plus its config on `main`. */
  async createRoom(
    roomId: string,
    options: { title?: string; purpose?: string; replyBudget?: number } = {},
  ): Promise<RoomConfig> {
    return await rooms.createRoom(this.roomsContext, roomId, options);
  }

  async joinRoom(roomId: string): Promise<void> {
    await rooms.joinRoom(this.roomsContext, roomId);
  }

  async leaveRoom(roomId: string): Promise<void> {
    await rooms.leaveRoom(this.roomsContext, roomId);
  }

  /** Kept on the facade: sending, sync and the reading domain all need it. */
  private async ensureRoomWorktree(roomId: string): Promise<string> {
    return await rooms.ensureRoomWorktree(this.roomsContext, roomId);
  }

  async readRoomConfig(roomId: string): Promise<RoomConfig | null> {
    return await rooms.readRoomConfig(this.roomsContext, roomId);
  }

  // ------------------------------------------------------------------ sending

  private get messagingContext(): MessagingContext {
    return {
      agentId: this.identity.id,
      repo: this.repo,
      state: this.state,
      lockPath: this.lockPath,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
      ensureRoomWorktree: async (roomId) => await this.ensureRoomWorktree(roomId),
      readRoomConfig: async (roomId) => await this.readRoomConfig(roomId),
      resolveMentions: async (mentions) => await this.resolveMentions(mentions),
      authenticityMode: async () => await this.authenticityMode(),
      signingKeyPath: async () => await this.signingKeyPath(),
      listAgents: async () => await this.listAgents(),
    };
  }

  async send(
    roomId: string,
    input: SendInput,
    extraRules: readonly SecretRule[] = [],
  ): Promise<Message> {
    return await messaging.send(this.messagingContext, roomId, input, extraRules);
  }

  /** Will a message mentioning these agents actually reach them? */
  async forecastDelivery(roomId: string, agents: readonly string[]): Promise<DeliveryForecast[]> {
    return await messaging.forecastDelivery(this.messagingContext, roomId, agents);
  }

  private get reviewsContext(): ReviewsContext {
    return {
      agentId: this.identity.id,
      send: async (roomId, input) => await this.send(roomId, input),
      read: async (roomId) => await this.read(roomId),
      requireApproval: async (kind, roomId, id, requester) => {
        await this.requireApproval(kind, roomId, id, requester);
      },
    };
  }

  /** Create a targeted agent-to-agent repository review task. */
  async requestReview(roomId: string, input: ReviewRequestInput): Promise<Message> {
    return await reviews.requestReview(this.reviewsContext, roomId, input);
  }

  /** Current valid state of every review task in a room. */
  async listReviewTasks(roomId: string): Promise<ReviewTaskStatus[]> {
    return await reviews.listReviewTasks(this.reviewsContext, roomId);
  }

  /** Append one guarded state transition to an existing review task. */
  async updateReview(roomId: string, reviewId: string, input: ReviewUpdateInput): Promise<Message> {
    return await reviews.updateReview(this.reviewsContext, roomId, reviewId, input);
  }

  // ------------------------------------------------------------------- claims

  /**
   * Take an advisory lease on a shared resource.
   *
   * Syncs, writes, then syncs and re-reads before answering. That round trip is
   * the point: on a git transport two agents can both write a claim before
   * either sees the other, so a method that returned "granted" the moment it
   * pushed would be the same guess the chat-message convention made. The second
   * read reports who actually won, deterministically, on both machines.
   *
   * Still advisory. Nothing stops a peer ignoring it — but a caller that checks
   * `granted` gets a real answer, and every hold expires on its own so a crashed
   * holder cannot strand the resource.
   */
  /**
   * Everything resource claiming is allowed to reach.
   *
   * Built here rather than handing over `this`, so the domain's dependencies
   * are a list you can read instead of whatever it happens to call through
   * `this` — and so the private guards stay private.
   */
  private get claimsContext(): ClaimsContext {
    return {
      agentId: this.identity.id,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
      sync: async () => await this.sync(),
      send: async (roomId, input) => await this.send(roomId, input),
      read: async (roomId) => await this.read(roomId),
    };
  }

  async claimResource(
    roomId: string,
    resource: string,
    options: { ttlSeconds?: number; note?: string } = {},
  ): Promise<{ granted: boolean; status: ClaimStatus | null }> {
    return await claims.claimResource(this.claimsContext, roomId, resource, options);
  }

  /** Release a resource this agent holds. Releasing something you do not hold is a no-op. */
  async releaseResource(roomId: string, resource: string, note?: string): Promise<boolean> {
    return await claims.releaseResource(this.claimsContext, roomId, resource, note);
  }

  /** Current holder of every claimed resource in a room, expiry included. */
  async listClaims(roomId: string, options: { sync?: boolean } = {}): Promise<ClaimStatus[]> {
    return await claims.listClaims(this.claimsContext, roomId, options);
  }

  /** Create a task targeted to one agent or free for any room subscriber to claim. */
  private get approvalsContext(): ApprovalsContext {
    return {
      agentId: this.identity.id,
      store: this.approvals,
      policy: async () => await this.policy(),
    };
  }

  private get tasksContext(): TasksContext {
    return {
      agentId: this.identity.id,
      machineId: this.identity.machine.id,
      subscriptions: this.config.subscriptions,
      capabilities: async () => await this.taskCapabilities(),
      send: async (roomId, input) => await this.send(roomId, input),
      read: async (roomId) => await this.read(roomId),
      requireApproval: async (kind, roomId, id, requester) => {
        await this.requireApproval(kind, roomId, id, requester);
      },
    };
  }

  /**
   * The capability names this agent declares on its profile.
   *
   * Profile capabilities are free text; only the entries that are valid task
   * capability names (`[a-z][a-z0-9-]{0,31}`) can satisfy `task_requires`. An
   * unreadable profile declares nothing rather than failing the caller.
   */
  async taskCapabilities(): Promise<string[]> {
    const profile = await this.getAgentProfile().catch(() => null);
    return (profile?.capabilities ?? []).filter((name) => isTaskCapability(name));
  }

  async createTask(roomId: string, input: TaskCreateInput): Promise<Message> {
    return await tasks.createTask(this.tasksContext, roomId, input);
  }

  /** Current valid state of every collaborative task in a room. */
  async listTasks(roomId: string): Promise<TaskStatus[]> {
    return await tasks.listTasks(this.tasksContext, roomId);
  }

  /** One task with its whole accepted history — the resumption path. */
  async showTask(roomId: string, taskId: string): Promise<TaskDetail> {
    return await tasks.showTask(this.tasksContext, roomId, taskId);
  }

  /** Unfinished work involving this agent, across every subscribed room. */
  async agenda(options: AgendaRequest = {}): Promise<Agenda> {
    return await tasks.agenda(this.tasksContext, options);
  }

  /** What this session was in the middle of, with the last thing it recorded. */
  async resume(limit = 3): Promise<ResumePoint[]> {
    return await tasks.resume(this.tasksContext, limit);
  }

  /** Kept on the facade: reviews gate their claim through it too. */
  private async requireApproval(
    kind: ApprovalKind,
    roomId: string,
    id: string,
    requester: string,
  ): Promise<void> {
    await approvals.requireApproval(this.approvalsContext, kind, roomId, id, requester);
  }

  /** Record that a person approved this agent taking on one piece of work. */
  async approveInboundWork(
    kind: ApprovalKind,
    roomId: string,
    id: string,
    note?: string,
  ): Promise<ApprovalRecord> {
    return await approvals.approveInboundWork(this.approvalsContext, kind, roomId, id, note);
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    return await approvals.listApprovals(this.approvalsContext);
  }

  async revokeApproval(kind: ApprovalKind, id: string): Promise<boolean> {
    return await approvals.revokeApproval(this.approvalsContext, kind, id);
  }

  /** Claim a task for this agent and publish that assignment to its participants. */
  async claimTask(
    roomId: string,
    taskId: string,
    body: string,
    capabilities?: readonly string[],
  ): Promise<Message> {
    return await tasks.claimTask(this.tasksContext, roomId, taskId, body, capabilities);
  }

  /** Append one guarded task refinement, progress update, or lifecycle transition. */
  async updateTask(roomId: string, taskId: string, input: TaskUpdateInput): Promise<Message> {
    return await tasks.updateTask(this.tasksContext, roomId, taskId, input);
  }

  /** Answer a message. `needs: human` only through the explicit relay flow. */
  async answer(messageId: string, body: string, options: AnswerOptions = {}): Promise<Message> {
    return await messaging.answer(this.messagingContext, messageId, body, options);
  }

  // ---------------------------------------------------------------- handshake

  private get handshakeContext(): HandshakeContext {
    return {
      identity: this.identity,
      config: this.config,
      state: this.state,
      joinRoom: async (roomId) => await this.joinRoom(roomId),
      publishAgentCard: async (extras) => await this.publishAgentCard(extras),
      sync: async () => await this.sync(),
      send: async (roomId, input) => await this.send(roomId, input),
      presenceRoster: async () => await this.presenceRoster(),
    };
  }

  /** Stamp this agent as seen, without sending anything. */
  async announce(status: "live" | "away", options: { session?: string } = {}): Promise<boolean> {
    return await handshakes.announce(this.handshakeContext, status, options);
  }

  /** Open — or answer — a first-contact exchange. Returns once the greeting is durable. */
  async handshake(input: HandshakeInput = {}): Promise<HandshakeResult> {
    return await handshakes.handshake(this.handshakeContext, input);
  }

  // ------------------------------------------------------------------ receipts

  /**
   * Publish what this agent has read of a room.
   *
   * Called after draining, because that is the moment "I have handled this"
   * becomes true. It writes only this agent's own receipt file, one of the
   * agent-owned records that `mayModify` lets it rewrite.
   *
   * Returns false when nothing moved: a receipt that re-published an unchanged
   * high-water mark would put a commit on `main` every time an agent looked at
   * an empty inbox.
   */
  private get deliveryContext(): DeliveryContext {
    return {
      networkId: this.id,
      agentId: this.identity.id,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      subscriptions: this.config.subscriptions,
      recordWorktree: this.recordWorktree,
      lockPath: this.lockPath,
      listAgents: async () => await this.listAgents(),
      read: async (roomId, options) => await this.read(roomId, options),
    };
  }

  async publishReceipt(roomId: string): Promise<boolean> {
    return await delivery.publishReceipt(this.deliveryContext, roomId);
  }

  /** Every agent's read position in one room, newest first. */
  async readReceipts(roomId: string): Promise<ReadReceipt[]> {
    return await delivery.readReceipts(this.deliveryContext, roomId);
  }

  /** What actually happened to one message, per recipient. */
  async trace(messageId: string): Promise<MessageTrace | null> {
    return await delivery.trace(this.deliveryContext, messageId);
  }

  // ---------------------------------------------------------------- discovery

  /** Find messages addressed to this agent in rooms it does NOT follow. */
  async discoverMentions(options: { limitPerRoom?: number } = {}): Promise<DiscoveredMention[]> {
    return await discovery.discoverMentions(
      {
        agentId: this.identity.id,
        machineId: this.identity.machine.id,
        repo: this.repo,
        remote: this.config.remote,
        subscriptions: this.config.subscriptions,
      },
      options,
    );
  }

  // ------------------------------------------------------------------- waiting

  /** Block until something matching lands in the inbox, or the bound expires. */
  async waitForInbox(options: WaitForInboxOptions = {}): Promise<WaitForInboxResult> {
    return await waiting.waitForInbox(
      { inbox: (query) => this.inbox(query), sync: async () => await this.sync() },
      options,
    );
  }

  // ------------------------------------------------------------------ reading

  private get readingContext(): ReadingContext {
    return {
      networkId: this.id,
      layout: this.layout,
      repo: this.repo,
      subscriptions: this.config.subscriptions,
      recordWorktree: this.recordWorktree,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
      ensureRoomWorktree: async (roomId) => await this.ensureRoomWorktree(roomId),
    };
  }

  async read(
    roomId: string,
    options: { limit?: number; thread?: string } = {},
  ): Promise<Message[]> {
    return await reading.read(this.readingContext, roomId, options);
  }

  /** Read past the live window, via git history. */
  async history(
    roomId: string,
    options: { since?: string; limit?: number } = {},
  ): Promise<Message[]> {
    return await reading.history(this.readingContext, roomId, options);
  }

  /** Substring search across the live window of subscribed rooms. */
  async search(
    query: string,
    options: { room?: string; limit?: number } = {},
  ): Promise<{ room: string; message: Message }[]> {
    return await reading.search(this.readingContext, query, options);
  }

  /**
   * Every decision a room has recorded — sealed documents and live messages both.
   *
   * Sealing promises decisions outlive compaction; this is the read path that
   * makes the promise checkable, because neither `read` nor `search` reaches
   * the record branch where a sealed decision lives.
   */
  async decisions(
    roomId: string,
    options: { limit?: number; includeSuperseded?: boolean } = {},
  ): Promise<reading.RoomDecision[]> {
    return await reading.decisions(this.readingContext, roomId, options);
  }

  // ------------------------------------------------------------------ sealing

  private get sealingContext(): SealingContext {
    return {
      networkId: this.id,
      agentId: this.identity.id,
      remote: this.config.remote,
      subscriptions: this.config.subscriptions,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      lockPath: this.lockPath,
      readRoomConfig: async (roomId) => await this.readRoomConfig(roomId),
    };
  }

  /** Only git config and the manifest — deliberately not the sealing context. */
  private get authenticityContext(): AuthenticityContext {
    return { runner: this.repo.runner, recordWorktree: this.recordWorktree };
  }

  /** The git identity this machine commits with. */
  async gitIdentity(): Promise<{ name: string; email: string } | null> {
    return await authenticity.gitIdentity(this.authenticityContext);
  }

  /** SSH key used for `authenticity: signed`, or null when none is configured. */
  private async signingKeyPath(): Promise<string | null> {
    return await authenticity.signingKeyPath(this.authenticityContext);
  }

  /** The network manifest from `main`, which carries the authenticity mode. */
  async readManifest(): Promise<NetManifest | null> {
    return await authenticity.readManifest(this.authenticityContext);
  }

  async authenticityMode(): Promise<AuthenticityMode> {
    return await authenticity.authenticityMode(this.authenticityContext);
  }

  /** What sealing this room would do, without touching anything. */
  async sealDecision(roomId: string): Promise<SealDecision> {
    return await sealing.sealDecision(this.sealingContext, roomId);
  }

  /**
   * Compact a room: merge its live branch into `main`, write a digest, promote
   * decisions, then prune the sealed messages out of both trees.
   */
  async seal(roomId: string): Promise<SealResult> {
    return await sealing.seal(this.sealingContext, roomId);
  }

  /** Rooms whose live window has outgrown their retention policy. */
  async roomsNeedingSeal(): Promise<SealDecision[]> {
    return await sealing.roomsNeedingSeal(this.sealingContext);
  }

  private get inboxContext(): InboxContext {
    return {
      state: this.state,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
    };
  }

  /** Nothing in common with the inbox but a section heading: git, not the state db. */
  private get outboxContext(): OutboxContext {
    return {
      networkId: this.id,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      subscriptions: this.config.subscriptions,
      remote: this.config.remote,
      recordWorktree: this.recordWorktree,
    };
  }

  inbox(query: InboxQuery = {}): InboxItem[] {
    return inboxOps.inbox(this.inboxContext, query);
  }

  /**
   * Mark items processed. `needs: human` items are refused — only an answer
   * recorded through the human-relay path clears those.
   */
  drainInbox(ids: readonly string[]): { drained: number; refused: string[] } {
    return inboxOps.drainInbox(this.inboxContext, ids);
  }

  // ------------------------------------------------------------------- outbox

  /** Rooms holding local commits the remote has not seen. */
  async outbox(): Promise<OutboxEntry[]> {
    return await outboxOps.outbox(this.outboxContext);
  }

  /** Push anything queued while offline. */
  async drainOutbox(): Promise<{ roomId: string; pushed: number }[]> {
    return await outboxOps.drainOutbox(this.outboxContext);
  }

  /** Keep the record branch convergent, like the room outboxes. */
  private async drainRecordOutbox(): Promise<void> {
    await outboxOps.drainRecordOutbox(this.outboxContext);
  }

  // --------------------------------------------------------------------- sync

  /** Whether this agent's view of the network can be trusted right now. */
  health(now = Date.now()): TransportHealth {
    return syncing.health(this.syncContext, now);
  }

  /**
   * Refuse to answer for a room this agent does not follow.
   *
   * Routing only ever delivers within subscribed rooms, so the cache holds
   * nothing for any other room — and returning `[]` states, falsely, that the
   * room is quiet. An unsubscribed read is a mistake worth surfacing, not a
   * result worth reporting.
   */
  private assertSubscribed(roomId: string, verb: string): void {
    if (this.config.subscriptions.includes(roomId)) return;
    throw new NotSubscribedError(roomId, verb);
  }

  private get syncContext(): SyncContext {
    return {
      identity: this.identity,
      config: this.config,
      repo: this.repo,
      state: this.state,
      recordWorktree: this.recordWorktree,
      lockPath: this.lockPath,
      drainRecordOutbox: async () => await this.drainRecordOutbox(),
      drainOutbox: async () => await this.drainOutbox(),
      authenticityMode: async () => await this.authenticityMode(),
      listAgents: async () => await this.listAgents(),
      ensureRoomWorktree: async (roomId) => await this.ensureRoomWorktree(roomId),
    };
  }

  async sync(): Promise<SyncReport> {
    return await syncing.sync(this.syncContext);
  }

  private get statusContext(): StatusContext {
    return {
      networkId: this.id,
      identity: this.identity,
      config: this.config,
      state: this.state,
      agenda: async (options) => await this.agenda(options),
      peers: async () => await this.peers(),
      outbox: async () => await this.outbox(),
      health: () => this.health(),
    };
  }

  /** What is going on around this agent, as opposed to addressed to it. */
  surroundings(): Surroundings {
    return statusOps.surroundings(this.statusContext);
  }

  async status(): Promise<NetworkStatus> {
    return await statusOps.status(this.statusContext);
  }

  /** Render pending items as plain markdown, for agents with no integration. */
  async writeInboxFiles(): Promise<number> {
    const dir = this.layout.agentInboxDir(this.identity.id);
    await mkdir(dir, { recursive: true });
    const items = this.state.listInbox({});
    for (const item of items) {
      const file = join(dir, `${item.room}--${item.id}.md`);
      if (await exists(file)) continue;
      await writeFile(
        file,
        `# ${item.room} · ${item.from}\n\n` +
          `- id: ${item.id}\n- kind: ${item.kind}\n- needs: ${item.needs}\n` +
          `- priority: ${item.priority}\n- sent: ${item.ts}\n\n---\n\n${item.body}\n`,
        "utf8",
      );
    }
    return items.length;
  }

  close(): void {
    this.state.close();
  }
}
