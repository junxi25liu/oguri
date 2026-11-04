/**
 * IPC method dispatch: one case per socket method, each a call into `Network`.
 *
 * The CLI and MCP server reach the same `Network` methods through `Backend`,
 * so this switch and the direct backend's answer the same questions.
 */

import type {
  ApprovalKind,
  AgentRuntimeEnvironment,
  Network,
  OguriConfig,
  SyncReport,
} from "@oguri/core";
import { redactPolicy } from "@oguri/core";

import type { IpcRequest, Method } from "../protocol.ts";
import type { NetworkContext, SessionRegistration } from "./types.ts";

/** What IPC dispatch needs from the daemon. */
export interface DispatchContext {
  /** Read live: `refreshConfig` replaces it under a running daemon. */
  config(): OguriConfig | null;
  readonly networks: Map<string, NetworkContext>;
  readonly socketPath: string;
  sessionLive(): boolean;
  sessionCount(networkId: string): number;
  resolve(networkId?: string): NetworkContext;
  onReport(networkId: string, network: Network, report: SyncReport): Promise<void>;
  onSessionChange(): Promise<void>;
  publishProfile(networkId: string, environment: AgentRuntimeEnvironment): Promise<void>;
  persistSubscriptions(): Promise<void>;
  stop(): Promise<void>;
  log(message: string): void;
}

export async function dispatch(
  daemon: DispatchContext,
  method: Method,
  request: IpcRequest,
  session: SessionRegistration,
): Promise<unknown> {
  const params = request.params ?? {};
  const p = <T>(key: string): T | undefined => params[key] as T | undefined;

  switch (method) {
    case "ping":
      return {
        pong: true,
        pid: process.pid,
        // Named so a client can refuse a daemon that serves someone else
        // rather than quietly reading another agent's inbox.
        agent: daemon.config()?.agent.id ?? null,
        networks: [...daemon.networks.keys()],
        defaultNetwork: daemon.config()?.defaultNetwork ?? null,
      };

    case "sessionOpen": {
      // An MCP server's lifetime IS an agent session's lifetime, which is
      // what makes presence meaningful rather than guessed.
      const ctx = daemon.resolve(request.network);
      session.markSession(ctx.config.id);
      await daemon.onSessionChange();
      const environment = p<AgentRuntimeEnvironment>("environment");
      if (environment !== undefined) await daemon.publishProfile(ctx.config.id, environment);
      return { sessionLive: true, sessions: daemon.sessionCount(ctx.config.id) };
    }
    case "sessionClose": {
      const networkId = session.network();
      session.markSession(null);
      await daemon.onSessionChange();
      const sessions = networkId === null ? 0 : daemon.sessionCount(networkId);
      return { sessionLive: sessions > 0, sessions };
    }

    case "shutdown":
      setTimeout(() => void daemon.stop(), 10).unref();
      return { stopping: true };

    case "status": {
      const ctx = daemon.resolve(request.network);
      const sessions = daemon.sessionCount(ctx.config.id);
      const status = await ctx.network.status();
      return {
        ...status,
        daemon: {
          pid: process.pid,
          socket: daemon.socketPath,
          sessionLive: sessions > 0,
          sessions,
          cadence: ctx.loop.state,
          loopRunning: ctx.loop.isRunning,
          lastLoopSyncAt: ctx.loop.lastSyncAt,
        },
      };
    }

    case "sync": {
      const ctx = daemon.resolve(request.network);
      const report = await ctx.network.sync();
      await daemon.onReport(ctx.config.id, ctx.network, report);
      return report;
    }

    case "rooms":
      return await daemon.resolve(request.network).network.listRooms();

    case "roomShow":
      return await daemon.resolve(request.network).network.readRoomConfig(p<string>("room") ?? "");

    case "roomCreate": {
      const ctx = daemon.resolve(request.network);
      const title = p<string>("title");
      const purpose = p<string>("purpose");
      const replyBudget = p<number>("replyBudget");
      const room = await ctx.network.createRoom(p<string>("room") ?? "", {
        ...(title === undefined ? {} : { title }),
        ...(purpose === undefined ? {} : { purpose }),
        ...(replyBudget === undefined ? {} : { replyBudget }),
      });
      await daemon.persistSubscriptions();
      ctx.loop.wake("room created");
      return room;
    }

    case "roomJoin": {
      const ctx = daemon.resolve(request.network);
      await ctx.network.joinRoom(p<string>("room") ?? "");
      await daemon.persistSubscriptions();
      ctx.loop.wake("room joined");
      return { joined: p<string>("room") };
    }

    case "roomLeave": {
      const ctx = daemon.resolve(request.network);
      await ctx.network.leaveRoom(p<string>("room") ?? "");
      await daemon.persistSubscriptions();
      return { left: p<string>("room") };
    }

    case "send": {
      const ctx = daemon.resolve(request.network);
      const message = await ctx.network.send(
        p<string>("room") ?? "",
        (params["input"] ?? {}) as Parameters<Network["send"]>[1],
      );
      // A reply is likely imminent, so drop straight to the hot cadence.
      ctx.loop.wake("local send");
      return message;
    }

    case "answer": {
      const ctx = daemon.resolve(request.network);
      // No `confirmHuman`: the socket is the ordinary agent path. Human-relay
      // attribution stays on the interactive CLI and is cooperative, not proof.
      const message = await ctx.network.answer(
        p<string>("messageId") ?? "",
        p<string>("body") ?? "",
      );
      ctx.loop.wake("local answer");
      return message;
    }

    case "reviewRequest": {
      const ctx = daemon.resolve(request.network);
      const message = await ctx.network.requestReview(
        p<string>("room") ?? "",
        (params["input"] ?? {}) as Parameters<Network["requestReview"]>[1],
      );
      ctx.loop.wake("review requested");
      return message;
    }

    case "reviewUpdate": {
      const ctx = daemon.resolve(request.network);
      const message = await ctx.network.updateReview(
        p<string>("room") ?? "",
        p<string>("reviewId") ?? "",
        (params["input"] ?? {}) as Parameters<Network["updateReview"]>[2],
      );
      ctx.loop.wake("review updated");
      return message;
    }

    case "reviews":
      return await daemon.resolve(request.network).network.listReviewTasks(p<string>("room") ?? "");

    case "taskCreate": {
      const ctx = daemon.resolve(request.network);
      const message = await ctx.network.createTask(
        p<string>("room") ?? "",
        (params["input"] ?? {}) as Parameters<Network["createTask"]>[1],
      );
      ctx.loop.wake("task created");
      return message;
    }

    case "taskClaim": {
      const ctx = daemon.resolve(request.network);
      const message = await ctx.network.claimTask(
        p<string>("room") ?? "",
        p<string>("taskId") ?? "",
        p<string>("body") ?? "",
        p<string[]>("capabilities"),
      );
      ctx.loop.wake("task claimed");
      return message;
    }

    case "taskUpdate": {
      const ctx = daemon.resolve(request.network);
      const message = await ctx.network.updateTask(
        p<string>("room") ?? "",
        p<string>("taskId") ?? "",
        (params["input"] ?? {}) as Parameters<Network["updateTask"]>[2],
      );
      ctx.loop.wake("task updated");
      return message;
    }

    case "tasks":
      return await daemon.resolve(request.network).network.listTasks(p<string>("room") ?? "");

    case "claim": {
      const ctx = daemon.resolve(request.network);
      const ttlSeconds = p<number>("ttlSeconds");
      const note = p<string>("note");
      const result = await ctx.network.claimResource(
        p<string>("room") ?? "",
        p<string>("resource") ?? "",
        {
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          ...(note === undefined ? {} : { note }),
        },
      );
      ctx.loop.wake("resource claimed");
      return result;
    }

    case "claimRelease": {
      const ctx = daemon.resolve(request.network);
      const released = await ctx.network.releaseResource(
        p<string>("room") ?? "",
        p<string>("resource") ?? "",
      );
      ctx.loop.wake("resource released");
      return { released };
    }

    case "claims":
      return await daemon.resolve(request.network).network.listClaims(p<string>("room") ?? "");

    case "taskShow":
      return await daemon
        .resolve(request.network)
        .network.showTask(p<string>("room") ?? "", p<string>("taskId") ?? "");

    case "policy":
      // A client may be an agent, so credentials never cross the socket.
      return redactPolicy(await daemon.resolve(request.network).network.policy());

    case "approvals":
      return await daemon.resolve(request.network).network.listApprovals();

    case "approve": {
      const ctx = daemon.resolve(request.network);
      const note = p<string>("note");
      const record = await ctx.network.approveInboundWork(
        (p<string>("kind") ?? "task") as ApprovalKind,
        p<string>("room") ?? "",
        p<string>("id") ?? "",
        ...(note === undefined ? [] : [note]),
      );
      daemon.log(`[${ctx.config.id}] approved ${record.kind} ${record.id}`);
      return record;
    }

    case "approveRevoke": {
      const ctx = daemon.resolve(request.network);
      return {
        revoked: await ctx.network.revokeApproval(
          (p<string>("kind") ?? "task") as ApprovalKind,
          p<string>("id") ?? "",
        ),
      };
    }

    case "agenda": {
      const ctx = daemon.resolve(request.network);
      const limit = p<number>("limit");
      const includeUnclaimed = p<boolean>("includeUnclaimed");
      const includeCapable = p<string[] | true>("includeCapable");
      return await ctx.network.agenda({
        ...(limit === undefined ? {} : { limit }),
        ...(includeUnclaimed === undefined ? {} : { includeUnclaimed }),
        ...(includeCapable === undefined ? {} : { includeCapable }),
      });
    }

    case "resume": {
      const ctx = daemon.resolve(request.network);
      const limit = p<number>("limit");
      return limit === undefined ? await ctx.network.resume() : await ctx.network.resume(limit);
    }

    case "read": {
      const ctx = daemon.resolve(request.network);
      const limit = p<number>("limit");
      const thread = p<string>("thread");
      return await ctx.network.read(p<string>("room") ?? "", {
        ...(limit === undefined ? {} : { limit }),
        ...(thread === undefined ? {} : { thread }),
      });
    }

    case "history": {
      const ctx = daemon.resolve(request.network);
      const since = p<string>("since");
      const limit = p<number>("limit");
      return await ctx.network.history(p<string>("room") ?? "", {
        ...(since === undefined ? {} : { since }),
        ...(limit === undefined ? {} : { limit }),
      });
    }

    case "decisions": {
      const ctx = daemon.resolve(request.network);
      const limit = p<number>("limit");
      const includeSuperseded = p<boolean>("includeSuperseded");
      return await ctx.network.decisions(p<string>("room") ?? "", {
        ...(limit === undefined ? {} : { limit }),
        ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
      });
    }

    case "search": {
      const ctx = daemon.resolve(request.network);
      const room = p<string>("room");
      const limit = p<number>("limit");
      return await ctx.network.search(p<string>("query") ?? "", {
        ...(room === undefined ? {} : { room }),
        ...(limit === undefined ? {} : { limit }),
      });
    }

    case "health":
      return daemon.resolve(request.network).network.health();

    case "outbox":
      return await daemon.resolve(request.network).network.outbox();

    case "surroundings":
      return daemon.resolve(request.network).network.surroundings();

    case "networks": {
      // Answered from the daemon's live set, which `refreshConfig` keeps in
      // step with the file — so a network added in another terminal is
      // listed without restarting anything.
      const current = daemon.resolve(request.network).config.id;
      return [...daemon.networks.values()]
        .map((ctx) => ({
          id: ctx.config.id,
          remote: ctx.config.remote,
          subscriptions: [...ctx.network.config.subscriptions],
          current: ctx.config.id === current,
        }))
        .sort((a, b) => (a.current === b.current ? a.id.localeCompare(b.id) : a.current ? -1 : 1));
    }

    case "trace":
      return await daemon.resolve(request.network).network.trace(p<string>("messageId") ?? "");

    case "forecastDelivery":
      return await daemon
        .resolve(request.network)
        .network.forecastDelivery(p<string>("room") ?? "", p<string[]>("agents") ?? []);

    case "inbox": {
      const ctx = daemon.resolve(request.network);
      const room = p<string>("room");
      const needs = p<string>("needs");
      // `tag` was honoured in direct mode and dropped here, so the same
      // command filtered or did not depending on whether a daemon happened to
      // be running. Both backends answer the same question or neither does.
      const tag = p<string>("tag");
      return ctx.network.inbox({
        ...(room === undefined ? {} : { room }),
        ...(needs === undefined ? {} : { needs }),
        ...(tag === undefined ? {} : { tag }),
      });
    }

    case "inboxDrain": {
      const ctx = daemon.resolve(request.network);
      const ids = p<string[]>("ids") ?? [];
      const drained = ctx.network.drainInbox(ids);
      for (const room of new Set(p<string[]>("rooms") ?? [])) {
        await ctx.network.publishReceipt(room).catch(() => undefined);
      }
      return drained;
    }

    case "receipts":
      return await daemon.resolve(request.network).network.readReceipts(p<string>("room") ?? "");

    case "mentions":
      return await daemon.resolve(request.network).network.discoverMentions();

    case "waitInbox": {
      const ctx = daemon.resolve(request.network);
      return await ctx.network.waitForInbox(
        (params["query"] ?? {}) as Parameters<Network["waitForInbox"]>[0],
      );
    }

    case "agents":
      return await daemon.resolve(request.network).network.listAgentDirectory();

    case "machines":
      return await daemon.resolve(request.network).network.machines();

    case "peers":
      return await daemon.resolve(request.network).network.peers();

    case "machineRoom": {
      const ctx = daemon.resolve(request.network);
      const joined = await ctx.network.machineRoom();
      if (joined.created || joined.joined) {
        await daemon.persistSubscriptions();
        ctx.loop.wake("machine room joined");
      }
      return joined;
    }

    case "profileGet":
      return await daemon.resolve(request.network).network.getAgentProfile(p<string>("agent"));

    case "profileUpdate": {
      const ctx = daemon.resolve(request.network);
      const published = await ctx.network.publishAgentProfile(
        (params["input"] ?? {}) as Parameters<Network["publishAgentProfile"]>[0],
      );
      return { published, profile: await ctx.network.getAgentProfile() };
    }

    case "sealCheck":
      return await daemon.resolve(request.network).network.sealDecision(p<string>("room") ?? "");

    case "seal": {
      const ctx = daemon.resolve(request.network);
      const result = await ctx.network.seal(p<string>("room") ?? "");
      if (result.sealed > 0) daemon.log(`[${ctx.config.id}] ${JSON.stringify(result)}`);
      return result;
    }

    case "announce": {
      const ctx = daemon.resolve(request.network);
      const session = p<string>("session");
      return {
        published: await ctx.network.announce(
          p<"live" | "away">("status") ?? "live",
          session === undefined ? {} : { session },
        ),
      };
    }

    case "handshake": {
      const ctx = daemon.resolve(request.network);
      const result = await ctx.network.handshake(
        (params["input"] ?? {}) as Parameters<Network["handshake"]>[0],
      );
      // A handshake subscribes to the room it greets in when it has to, so
      // the new subscription has to outlive this process like any other join.
      await daemon.persistSubscriptions();
      // The point of a handshake is the reply, so drop to the hot cadence
      // rather than letting an idle poll interval decide when it lands.
      ctx.loop.wake("handshake");
      return result;
    }

    case "presence": {
      const ctx = daemon.resolve(request.network);
      const rows = await ctx.network.presenceRoster();
      // Only this agent's own row is answered from the daemon rather than the
      // record: the daemon knows whether a session is attached right now,
      // which no published card can.
      return rows.map((row) =>
        row.id === ctx.network.identity.id
          ? { ...row, status: daemon.sessionLive() ? ("live" as const) : ("away" as const) }
          : row,
      );
    }
  }
}
