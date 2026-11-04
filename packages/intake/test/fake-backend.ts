/**
 * A small in-memory `Backend` for the intake loop tests.
 *
 * Keeps each room's messages and answers the calls intake makes: `status`,
 * `roomJoin`, `tasks`, `read`, `claim`, `claimRelease`, `taskCreate`, `send`.
 * A test can make the claim belong to someone else, or make a write fail.
 */

import type { Backend } from "@oguri/daemon";
import type { SendInput, TaskCreateInput } from "@oguri/core";
import { ulid, type Message, type Task } from "@oguri/protocol";

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export class FakeBackend implements Backend {
  readonly mode = "direct" as const;
  calls: Call[] = [];
  rooms = new Map<string, Message[]>();
  subscriptions: string[] = [];
  /** Who holds the intake claim; null means it is free for the asker. */
  claimHolder: string | null = null;
  /** Throw this from the next writes of `method`. */
  failures = new Map<string, { error: Error; times: number }>();
  readonly agentId: string;
  constructor(agentId = "intake-bot") {
    this.agentId = agentId;
  }

  get created(): Message[] {
    return [...this.rooms.values()].flat().filter((m) => m.header.task !== undefined);
  }

  get sent(): Message[] {
    return [...this.rooms.values()].flat().filter((m) => m.header.task === undefined);
  }

  private push(room: string, message: Message): void {
    const list = this.rooms.get(room) ?? [];
    list.push(message);
    this.rooms.set(room, list);
  }

  private message(room: string, input: Partial<Message["header"]>, body: string): Message {
    const id = ulid();
    return {
      header: {
        v: 1,
        id,
        room,
        from: this.agentId,
        authorKind: "agent",
        kind: "msg",
        needs: "none",
        ts: new Date().toISOString(),
        thread: id,
        mentions: [],
        priority: "normal",
        tags: [],
        refs: [],
        extra: {},
        ...input,
      } as Message["header"],
      body,
    };
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.failures.get(method);
    if (failure !== undefined && failure.times > 0) {
      failure.times -= 1;
      return Promise.reject(failure.error);
    }
    const room = String(params["room"] ?? "");
    let result: unknown;
    switch (method) {
      case "sync":
        result = {};
        break;
      case "status":
        result = { networkId: "acme", subscriptions: [...this.subscriptions] };
        break;
      case "roomJoin":
        this.subscriptions.push(room);
        result = { joined: room };
        break;
      case "read":
        result = [...(this.rooms.get(room) ?? [])];
        break;
      case "tasks":
        result = (this.rooms.get(room) ?? [])
          .filter((m) => m.header.task !== undefined)
          .map((m) => ({
            task: m.header.task,
            rootMessageId: m.header.id,
            thread: m.header.thread,
            definition: m.body,
          }));
        break;
      case "claim": {
        const holder = this.claimHolder ?? this.agentId;
        result = {
          granted: holder === this.agentId,
          status: {
            holder,
            expiresAt: new Date(Date.now() + Number(params["ttlSeconds"]) * 1000).toISOString(),
          },
        };
        break;
      }
      case "claimRelease":
        result = { released: true };
        break;
      case "taskCreate": {
        const input = params["input"] as TaskCreateInput;
        const task: Task = {
          id: ulid(),
          creator: this.agentId,
          title: input.title,
          state: "open",
          action: "created",
          staleAfterSeconds: 86400,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.requires === undefined ? {} : { requires: input.requires }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
          ...(input.mandate === undefined ? {} : { mandate: input.mandate }),
        } as Task;
        const message = this.message(
          room,
          { kind: "question", needs: "agent", task },
          input.definition,
        );
        this.push(room, message);
        result = message;
        break;
      }
      case "send": {
        const input = params["input"] as SendInput;
        const message = this.message(
          room,
          {
            kind: input.kind ?? "msg",
            needs: input.needs ?? "none",
            authorKind: input.authorKind ?? "agent",
            mentions: input.mentions ?? [],
            tags: input.tags ?? [],
            ...(input.thread === undefined ? {} : { thread: input.thread }),
            ...(input.external === undefined ? {} : { external: input.external }),
          },
          input.body,
        );
        this.push(room, message);
        result = message;
        break;
      }
      default:
        return Promise.reject(new Error(`fake backend: unexpected ${method}`));
    }
    return Promise.resolve(result as T);
  }

  networks(): Promise<never[]> {
    return Promise.resolve([]);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
