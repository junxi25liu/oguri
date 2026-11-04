/**
 * The unix socket the CLI and MCP server talk to: binding it, framing what
 * arrives on each connection, and answering one request per line.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";

import { describeError, type Layout } from "@oguri/core";

import { DaemonClient } from "../client.ts";
import {
  LineFramer,
  encode,
  isMethod,
  type IpcRequest,
  type IpcResponse,
  type Method,
} from "../protocol.ts";
import type { SessionRegistration } from "./types.ts";

/** What the socket server needs from the daemon. */
export interface IpcContext {
  readonly layout: Layout;
  readonly socketPath: string;
  /** Attached session socket -> the one network selected by its desktop project. */
  readonly sessions: Map<Socket, string>;
  setServer(server: Server): void;
  nextConnectionId(): number;
  noteLocalActivity(): void;
  refreshConfig(): Promise<void>;
  onSessionChange(): Promise<void>;
  dispatch(method: Method, request: IpcRequest, session: SessionRegistration): Promise<unknown>;
  log(message: string): void;
}

export async function listen(daemon: IpcContext): Promise<void> {
  const path = daemon.socketPath;
  await mkdir(daemon.layout.root, { recursive: true });

  // A socket file left by a crash would make bind fail. Probe it first:
  // if something answers, another daemon owns this home and we must not
  // start a second one; if nothing does, the file is debris.
  const alive = await DaemonClient.isAlive(path);
  if (alive) {
    throw new Error(`another oguri daemon is already running on ${path}`);
  }
  await unlink(path).catch(() => undefined);

  const server = createServer((socket) => {
    onConnection(daemon, socket);
  });
  daemon.setServer(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Filesystem permissions ARE the authentication here — there is no token
  // and nothing listening on TCP (ADR 0005).
  await chmod(path, 0o600);
}

function onConnection(daemon: IpcContext, socket: Socket): void {
  const connectionId = daemon.nextConnectionId();
  const framer = new LineFramer();
  let declaredNetwork: string | null = null;
  let cleaned = false;

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let lines: string[];
    try {
      lines = framer.push(chunk);
    } catch (error) {
      socket.end(encode({ id: 0, ok: false, error: { message: describeError(error) } }));
      return;
    }
    for (const line of lines) {
      void handleLine(daemon, socket, line, {
        isSession: () => declaredNetwork !== null,
        network: () => declaredNetwork,
        markSession: (network: string | null) => {
          declaredNetwork = network;
          if (network === null) daemon.sessions.delete(socket);
          else daemon.sessions.set(socket, network);
        },
      });
    }
  });

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (declaredNetwork !== null) {
      daemon.sessions.delete(socket);
      declaredNetwork = null;
      void daemon.onSessionChange();
    }
    daemon.log(`connection ${String(connectionId)} closed`);
  };
  socket.on("close", cleanup);
  socket.on("error", () => cleanup());
}

async function handleLine(
  daemon: IpcContext,
  socket: Socket,
  line: string,
  session: SessionRegistration,
): Promise<void> {
  let request: IpcRequest;
  try {
    request = JSON.parse(line) as IpcRequest;
  } catch {
    socket.write(encode({ id: 0, ok: false, error: { message: "malformed JSON" } }));
    return;
  }

  const respond = (response: IpcResponse) => {
    if (!socket.destroyed) socket.write(encode(response));
  };

  if (typeof request.method !== "string" || !isMethod(request.method)) {
    respond({
      id: request.id ?? 0,
      ok: false,
      error: { message: `unknown method ${String(request.method)}`, code: "UNKNOWN_METHOD" },
    });
    return;
  }

  // Any request but a bare liveness probe means an agent is working this
  // machine right now. Local effects only: no presence is published, because
  // a command is not a session (see `agentNearby`).
  if (request.method !== "ping" && request.passive !== true) daemon.noteLocalActivity();
  await daemon.refreshConfig();

  try {
    const result = await daemon.dispatch(request.method, request, session);
    respond({ id: request.id, ok: true, result });
  } catch (error) {
    const code = errorCode(error);
    respond({
      id: request.id,
      ok: false,
      error: { message: describeError(error), ...(code === undefined ? {} : { code }) },
    });
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
