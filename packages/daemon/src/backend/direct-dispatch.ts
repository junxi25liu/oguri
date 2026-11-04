/**
 * Direct mode's answer to each IPC method: the same `Network` calls the
 * daemon's dispatch makes, against a network this process opened itself.
 */

import type { ApprovalKind, Network } from "@oguri/core";
import { redactPolicy } from "@oguri/core";

import type { DirectMethod } from "../protocol.ts";

/** What a direct-mode call needs from its backend. */
export interface DirectCallContext {
  persist(): Promise<void>;
}

export async function callDirect(
  backend: DirectCallContext,
  method: DirectMethod,
  params: Record<string, unknown>,
  net: Network,
): Promise<unknown> {
  const p = <V>(key: string): V | undefined => params[key] as V | undefined;
  let result: unknown;

  switch (method) {
    case "status":
      result = await net.status();
      break;
    case "sync":
      result = await net.sync();
      await net.writeInboxFiles();
      break;
    case "rooms":
      result = await net.listRooms();
      break;
    case "roomShow":
      result = await net.readRoomConfig(p<string>("room") ?? "");
      break;
    case "roomCreate": {
      const title = p<string>("title");
      const purpose = p<string>("purpose");
      const replyBudget = p<number>("replyBudget");
      result = await net.createRoom(p<string>("room") ?? "", {
        ...(title === undefined ? {} : { title }),
        ...(purpose === undefined ? {} : { purpose }),
        ...(replyBudget === undefined ? {} : { replyBudget }),
      });
      await backend.persist();
      break;
    }
    case "roomJoin":
      await net.joinRoom(p<string>("room") ?? "");
      await backend.persist();
      result = { joined: p<string>("room") };
      break;
    case "roomLeave":
      await net.leaveRoom(p<string>("room") ?? "");
      await backend.persist();
      result = { left: p<string>("room") };
      break;
    case "send":
      result = await net.send(
        p<string>("room") ?? "",
        (params["input"] ?? {}) as Parameters<Network["send"]>[1],
      );
      break;
    case "answer":
      result = await net.answer(p<string>("messageId") ?? "", p<string>("body") ?? "");
      break;
    case "reviewRequest":
      result = await net.requestReview(
        p<string>("room") ?? "",
        (params["input"] ?? {}) as Parameters<Network["requestReview"]>[1],
      );
      break;
    case "reviewUpdate":
      result = await net.updateReview(
        p<string>("room") ?? "",
        p<string>("reviewId") ?? "",
        (params["input"] ?? {}) as Parameters<Network["updateReview"]>[2],
      );
      break;
    case "reviews":
      result = await net.listReviewTasks(p<string>("room") ?? "");
      break;
    case "taskCreate":
      result = await net.createTask(
        p<string>("room") ?? "",
        (params["input"] ?? {}) as Parameters<Network["createTask"]>[1],
      );
      break;
    case "taskClaim":
      result = await net.claimTask(
        p<string>("room") ?? "",
        p<string>("taskId") ?? "",
        p<string>("body") ?? "",
        p<string[]>("capabilities"),
      );
      break;
    case "taskUpdate":
      result = await net.updateTask(
        p<string>("room") ?? "",
        p<string>("taskId") ?? "",
        (params["input"] ?? {}) as Parameters<Network["updateTask"]>[2],
      );
      break;
    case "tasks":
      result = await net.listTasks(p<string>("room") ?? "");
      break;
    case "claim": {
      const ttlSeconds = p<number>("ttlSeconds");
      const note = p<string>("note");
      result = await net.claimResource(p<string>("room") ?? "", p<string>("resource") ?? "", {
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        ...(note === undefined ? {} : { note }),
      });
      break;
    }
    case "claimRelease":
      result = {
        released: await net.releaseResource(p<string>("room") ?? "", p<string>("resource") ?? ""),
      };
      break;
    case "claims":
      result = await net.listClaims(p<string>("room") ?? "");
      break;
    case "taskShow":
      result = await net.showTask(p<string>("room") ?? "", p<string>("taskId") ?? "");
      break;
    case "policy":
      result = redactPolicy(await net.policy());
      break;
    case "approvals":
      result = await net.listApprovals();
      break;
    case "approve": {
      const note = p<string>("note");
      result = await net.approveInboundWork(
        (p<string>("kind") ?? "task") as ApprovalKind,
        p<string>("room") ?? "",
        p<string>("id") ?? "",
        ...(note === undefined ? [] : [note]),
      );
      break;
    }
    case "approveRevoke":
      result = {
        revoked: await net.revokeApproval(
          (p<string>("kind") ?? "task") as ApprovalKind,
          p<string>("id") ?? "",
        ),
      };
      break;
    case "agenda": {
      const limit = p<number>("limit");
      const includeUnclaimed = p<boolean>("includeUnclaimed");
      const includeCapable = p<string[] | true>("includeCapable");
      result = await net.agenda({
        ...(limit === undefined ? {} : { limit }),
        ...(includeUnclaimed === undefined ? {} : { includeUnclaimed }),
        ...(includeCapable === undefined ? {} : { includeCapable }),
      });
      break;
    }
    case "resume": {
      const limit = p<number>("limit");
      result = limit === undefined ? await net.resume() : await net.resume(limit);
      break;
    }
    case "read": {
      const limit = p<number>("limit");
      const thread = p<string>("thread");
      result = await net.read(p<string>("room") ?? "", {
        ...(limit === undefined ? {} : { limit }),
        ...(thread === undefined ? {} : { thread }),
      });
      break;
    }
    case "history": {
      const since = p<string>("since");
      const limit = p<number>("limit");
      result = await net.history(p<string>("room") ?? "", {
        ...(since === undefined ? {} : { since }),
        ...(limit === undefined ? {} : { limit }),
      });
      break;
    }
    case "search": {
      const room = p<string>("room");
      const limit = p<number>("limit");
      result = await net.search(p<string>("query") ?? "", {
        ...(room === undefined ? {} : { room }),
        ...(limit === undefined ? {} : { limit }),
      });
      break;
    }
    case "decisions": {
      const limit = p<number>("limit");
      const includeSuperseded = p<boolean>("includeSuperseded");
      result = await net.decisions(p<string>("room") ?? "", {
        ...(limit === undefined ? {} : { limit }),
        ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
      });
      break;
    }
    case "health":
      result = net.health();
      break;
    case "outbox":
      result = await net.outbox();
      break;
    case "surroundings":
      result = net.surroundings();
      break;
    case "trace":
      result = await net.trace(p<string>("messageId") ?? "");
      break;
    case "forecastDelivery":
      result = await net.forecastDelivery(p<string>("room") ?? "", p<string[]>("agents") ?? []);
      break;
    case "inbox": {
      const room = p<string>("room");
      const needs = p<string>("needs");
      const tag = p<string>("tag");
      result = net.inbox({
        ...(room === undefined ? {} : { room }),
        ...(needs === undefined ? {} : { needs }),
        ...(tag === undefined ? {} : { tag }),
      });
      break;
    }
    case "inboxDrain": {
      const drained = net.drainInbox(p<string[]>("ids") ?? []);
      // Publishing the receipt is part of draining: draining is the moment
      // "I have handled this" becomes true, and a receipt written at any
      // other moment would be claiming something that is not.
      for (const room of new Set(p<string[]>("rooms") ?? [])) {
        await net.publishReceipt(room).catch(() => undefined);
      }
      result = drained;
      break;
    }
    case "receipts":
      result = await net.readReceipts(p<string>("room") ?? "");
      break;
    case "mentions":
      result = await net.discoverMentions();
      break;
    case "waitInbox":
      result = await net.waitForInbox(
        (params["query"] ?? {}) as Parameters<Network["waitForInbox"]>[0],
      );
      break;
    case "agents":
      result = await net.listAgentDirectory();
      break;
    case "machines":
      result = await net.machines();
      break;
    case "peers":
      result = await net.peers();
      break;
    case "machineRoom": {
      const joined = await net.machineRoom();
      // Joining the machine room is a subscription change like any other, and
      // a one-shot process that does not write it back reports success while
      // the very next command refuses to read the room it just joined.
      if (joined.created || joined.joined) await backend.persist();
      result = joined;
      break;
    }
    case "profileGet":
      result = await net.getAgentProfile(p<string>("agent"));
      break;
    case "profileUpdate": {
      const published = await net.publishAgentProfile(
        (params["input"] ?? {}) as Parameters<Network["publishAgentProfile"]>[0],
      );
      result = { published, profile: await net.getAgentProfile() };
      break;
    }
    case "sealCheck":
      result = await net.sealDecision(p<string>("room") ?? "");
      break;
    case "seal":
      result = await net.seal(p<string>("room") ?? "");
      break;
    case "announce": {
      const session = p<string>("session");
      result = {
        published: await net.announce(
          p<"live" | "away">("status") ?? "live",
          session === undefined ? {} : { session },
        ),
      };
      break;
    }
    case "handshake":
      result = await net.handshake((params["input"] ?? {}) as Parameters<Network["handshake"]>[0]);
      await backend.persist();
      break;
    case "presence":
      result = await net.presenceRoster();
      break;
    default: {
      // Exhaustiveness, not a runtime guard: `method` is only assignable to
      // `never` here when every DirectMethod above has a case. Add an entry
      // to METHODS without implementing it, and this line fails the build
      // instead of failing at a user's call.
      const unimplemented: never = method;
      throw new Error(
        `method '${String(unimplemented)}' has no direct-mode implementation — implement it here, or add it to DAEMON_ONLY_METHODS with the reason`,
      );
    }
  }
  return result;
}
