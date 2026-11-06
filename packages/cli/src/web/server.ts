/**
 * The HTTP side of `oguri web` (ADR 0028): a read-only view over `Backend`.
 *
 * Read-only is enforced, not intended. The server reaches the network only
 * through `ReadOnlyBackend`, which permits an explicit list of read methods,
 * and it answers nothing but GET and HEAD. The separate `/chat` handler has
 * its own write-capable route and guards; this handler only registers it.
 *
 * Exposure is the other half. It binds to loopback by default. A non-loopback
 * bind needs `--allow-remote` and always a bearer token. On loopback, the Host
 * header must name loopback too: otherwise any web page could point a DNS name
 * at 127.0.0.1 and read the dashboard through the visitor's browser.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Agenda, InboxItem, MachineRow, PresenceRow } from "@oguri/core";

import {
  bearerMatches,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  hostName,
  isLoopbackHost,
  type BindPlan,
} from "./http.ts";
import { chatHandler, type ChatOptions } from "./chat-api.ts";
import {
  describe,
  humanItem,
  readDashboard,
  readRoom,
  readStatus,
  type DashboardSources,
} from "./data.ts";
import { sortNeedsYou } from "./needs-you.ts";
import { renderPage } from "./page.ts";

export {
  bearerMatches,
  DEFAULT_WEB_PORT,
  DEFAULT_WEB_HOST,
  isLoopbackHost,
  type BindPlan,
} from "./http.ts";

/** Several tabs polling at once share one aggregate for this long. */
const DASHBOARD_CACHE_MS = 2_000;

/**
 * Decide what to bind and whether a token guards it.
 *
 * Throws when a non-loopback host is asked for without `--allow-remote`. A
 * remote bind always gets a token: one is generated when none is given.
 */
export function planBind(options: {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  token?: string;
}): BindPlan {
  const host = options.host ?? DEFAULT_WEB_HOST;
  const port = options.port ?? DEFAULT_WEB_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("--port must be an integer from 0 to 65535");
  }
  if (options.token !== undefined && options.token.length < 16) {
    throw new RangeError("--token must be at least 16 characters");
  }
  if (isLoopbackHost(host)) {
    return { host, port, token: options.token ?? null, generated: false };
  }
  if (options.allowRemote !== true) {
    throw new Error(
      `refusing to serve on ${host}: it is reachable from other machines. ` +
        "Pass --allow-remote to do it anyway; a bearer token will be required.",
    );
  }
  if (options.token !== undefined) return { host, port, token: options.token, generated: false };
  return { host, port, token: randomBytes(24).toString("base64url"), generated: true };
}

export interface DashboardServerOptions extends DashboardSources, Omit<ChatOptions, "plan"> {
  plan: BindPlan;
  log?: (line: string) => void;
}

// One authoritative shape for the machine-local facts, shared with the dashboard fold.
export type { LocalPolicyFacts, LocalUsageFacts } from "./execution.ts";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
};

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
  head = false,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": type,
    "content-length": String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(head ? undefined : body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, head = false): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), {}, head);
}

/** Build the request handler. Exported so tests can drive it without a socket. */
export function dashboardHandler(
  options: DashboardServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { plan } = options;
  const loopback = isLoopbackHost(plan.host);
  const chat = chatHandler({ plan, ...(options.chat === undefined ? {} : { chat: options.chat }) });
  let cached: { at: number; value: Promise<Record<string, unknown>> } | null = null;

  const dashboard = (): Promise<Record<string, unknown>> => {
    const now = Date.now();
    if (cached !== null && now - cached.at < DASHBOARD_CACHE_MS) return cached.value;
    const value = readDashboard(options);
    cached = { at: now, value };
    return value;
  };

  const route = async (url: URL): Promise<unknown> => {
    switch (url.pathname) {
      case "/api/dashboard":
        return await dashboard();
      case "/api/status":
        return await readStatus(options);
      case "/api/machines":
        return {
          machines: await options.backend.call<MachineRow[]>("machines"),
          presence: await options.backend.call<PresenceRow[]>("presence"),
        };
      case "/api/agenda":
        return await options.backend.call<Agenda>("agenda", { limit: 100 });
      case "/api/needs-human":
        return (await options.backend.call<InboxItem[]>("inbox", { needs: "human" })).map(
          humanItem,
        );
      case "/api/needs-you": {
        const status = await readStatus(options);
        const rooms = await Promise.all(
          status.subscriptions.map((room) => readRoom(options, room)),
        );
        return sortNeedsYou(rooms.flatMap((room) => room.needsYou));
      }
      case "/api/rooms": {
        const status = await readStatus(options);
        return await Promise.all(status.subscriptions.map((room) => readRoom(options, room)));
      }
      case "/api/room": {
        const room = url.searchParams.get("room");
        if (room === null || room === "") throw new HttpError(400, "missing ?room=");
        return await readRoom(options, room);
      }
      case "/api/runs":
        return await options.listRuns(50);
      default:
        throw new HttpError(404, "not found");
    }
  };

  return (req, res) => {
    const head = req.method === "HEAD";
    // `/chat` has its own guarded handler. The dashboard below stays a
    // GET/HEAD-only surface over ReadOnlyBackend, exactly as before.
    if (chat(req, res, head)) return;
    if (req.method !== "GET" && !head) {
      send(res, 405, "text/plain; charset=utf-8", "read-only: GET and HEAD only\n", {
        allow: "GET, HEAD",
      });
      return;
    }
    const host = hostName(req);
    if (loopback && (host === null || !isLoopbackHost(host))) {
      send(res, 421, "text/plain; charset=utf-8", "this dashboard answers only on loopback\n");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // The page holds no data, so it is served without the token: the token
      // travels in the URL fragment, which a browser never sends here.
      const nonce = randomBytes(16).toString("base64");
      send(
        res,
        200,
        "text/html; charset=utf-8",
        renderPage(nonce),
        {
          "content-security-policy":
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
        head,
      );
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" }, head);
      return;
    }
    if (plan.token !== null && !bearerMatches(req.headers.authorization, plan.token)) {
      res.setHeader("www-authenticate", 'Bearer realm="oguri"');
      sendJson(res, 401, { error: "a bearer token is required" }, head);
      return;
    }
    route(url).then(
      (value) => sendJson(res, 200, value, head),
      (error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) options.log?.(`${url.pathname}: ${describe(error)}`);
        sendJson(res, status, { error: describe(error) }, head);
      },
    );
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Start listening. Resolves with the server and the port actually bound. */
export async function startDashboard(
  options: DashboardServerOptions,
): Promise<{ server: Server; port: number }> {
  const server = createServer(dashboardHandler(options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.plan.port, options.plan.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.plan.port;
  return { server, port };
}

/** The URL to open. The token goes in the fragment, which is never sent over HTTP. */
export function dashboardUrl(plan: BindPlan, port: number): string {
  const host = plan.host.includes(":") && !plan.host.startsWith("[") ? `[${plan.host}]` : plan.host;
  const base = `http://${host}:${String(port)}/`;
  return plan.token === null ? base : `${base}#token=${encodeURIComponent(plan.token)}`;
}
