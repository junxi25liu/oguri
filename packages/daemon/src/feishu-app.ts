/**
 * Message one person through a Feishu (Lark) self-built app (ADR 0028).
 *
 * A custom-bot webhook can only post to the group it was added to. To reach a
 * person directly, oguri acts as the owner's own app bot: it trades the App ID
 * and App Secret for a tenant access token, then calls the send-message API
 * with the person's email or open_id.
 *
 * The token lives about two hours. It is cached per app and refreshed a few
 * minutes before it expires, and once more when Feishu says it is invalid,
 * so a revoked or rotated token costs one retry, not a lost push.
 *
 * Nothing here logs or returns the secret or the token. An error names the
 * step and Feishu's code, never the request.
 */

import { createHash } from "node:crypto";

import type { PushChannel } from "@oguri/core";

export const FEISHU_API = "https://open.feishu.cn";

/** Refresh this long before Feishu's stated expiry, so a send never races it. */
const REFRESH_EARLY_MS = 5 * 60_000;
/** A token is never trusted for less than this, whatever `expire` says. */
const MIN_LIFETIME_MS = 60_000;

/** Feishu codes meaning the access token is missing, expired, or invalid. */
const TOKEN_ERRORS = new Set([99991661, 99991663, 99991664, 99991665, 99991668]);

export function feishuApiBase(channel: PushChannel): string {
  return (channel.apiUrl ?? FEISHU_API).replace(/\/+$/, "");
}

interface Cached {
  token: string;
  expiresAt: number;
}

interface Reply {
  status: number;
  payload: Record<string, unknown> | null;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Reply> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = raw === "" ? null : JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

function codeOf(reply: Reply): number | null {
  const code = reply.payload?.["code"];
  return typeof code === "number" ? code : null;
}

/** Feishu answers errors with a non-zero `code`, often on HTTP 400; read both. */
function failure(step: string, reply: Reply): string | null {
  const code = codeOf(reply);
  if (code !== null && code !== 0) return `feishu-app ${step}: code ${String(code)}`;
  if (reply.status < 200 || reply.status >= 300) {
    return `feishu-app ${step}: HTTP ${String(reply.status)}`;
  }
  return null;
}

class FeishuError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "FeishuError";
    this.code = code;
  }
}

/**
 * Tenant access tokens, one per app.
 *
 * Keyed by the API base, the App ID, and a hash of the secret, so a rotated
 * secret never reuses a token minted with the old one. Concurrent sends that
 * find no token share one request instead of minting several.
 */
export class FeishuTokenCache {
  private readonly tokens = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(channel: PushChannel): string {
    const secret = createHash("sha256")
      .update(channel.appSecret ?? "")
      .digest("hex");
    return `${feishuApiBase(channel)}\n${channel.appId ?? ""}\n${secret}`;
  }

  invalidate(channel: PushChannel): void {
    this.tokens.delete(this.key(channel));
  }

  async get(channel: PushChannel, timeoutMs: number): Promise<string> {
    const key = this.key(channel);
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.token;
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return await inFlight;

    const minting = this.mint(channel, timeoutMs).then((fresh) => {
      this.tokens.set(key, fresh);
      return fresh.token;
    });
    this.pending.set(key, minting);
    try {
      return await minting;
    } finally {
      this.pending.delete(key);
    }
  }

  private async mint(channel: PushChannel, timeoutMs: number): Promise<Cached> {
    const reply = await postJson(
      `${feishuApiBase(channel)}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: channel.appId, app_secret: channel.appSecret },
      {},
      timeoutMs,
    );
    const refused = failure("token", reply);
    if (refused !== null) throw new FeishuError(refused, codeOf(reply));
    const token = reply.payload?.["tenant_access_token"];
    if (typeof token !== "string" || token.length === 0) {
      throw new FeishuError("feishu-app token: no tenant_access_token in the reply", null);
    }
    const expire = reply.payload?.["expire"];
    const lifetimeMs =
      typeof expire === "number" && expire > 0 ? expire * 1000 - REFRESH_EARLY_MS : 0;
    return { token, expiresAt: this.now() + Math.max(MIN_LIFETIME_MS, lifetimeMs) };
  }
}

/** One cache for the daemon's lifetime, so pushes do not mint a token each. */
export const feishuTokens = new FeishuTokenCache();

/**
 * Send one text message as the app bot. Returns an error string, or null.
 *
 * `body` is the send-message request body, already built and scanned by the
 * caller. Throws only for a network failure, which the caller describes.
 */
export async function sendFeishuApp(
  channel: PushChannel,
  request: { url: string; body: unknown },
  options: { timeoutMs: number; tokens?: FeishuTokenCache },
): Promise<string | null> {
  const tokens = options.tokens ?? feishuTokens;
  let token: string;
  try {
    token = await tokens.get(channel, options.timeoutMs);
  } catch (error) {
    if (error instanceof FeishuError) return error.message;
    throw error;
  }

  const send = async (bearer: string): Promise<Reply> =>
    await postJson(
      request.url,
      request.body,
      { authorization: `Bearer ${bearer}` },
      options.timeoutMs,
    );

  let reply = await send(token);
  const code = codeOf(reply);
  if (code !== null && TOKEN_ERRORS.has(code)) {
    // Revoked, rotated, or expired early: mint once more and try again.
    tokens.invalidate(channel);
    try {
      token = await tokens.get(channel, options.timeoutMs);
    } catch (error) {
      if (error instanceof FeishuError) return error.message;
      throw error;
    }
    reply = await send(token);
  }
  return failure("send", reply);
}
