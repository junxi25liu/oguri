/**
 * A small Feishu (Lark) open-platform client for intake (ADR 0030).
 *
 * Intake acts as the team's self-built app bot: it reads chat messages, looks
 * up the bot's own identity, and replies under the message that asked for
 * work. Every call goes through the tenant access token that push
 * notifications already cache (`FeishuTokenCache`), so the token is minted
 * once per app and refreshed before it expires.
 *
 * Nothing here logs or returns the app secret or the token. An error names the
 * API path and Feishu's code, never the request.
 */

import { FEISHU_API, FeishuTokenCache } from "@oguri/daemon";
import type { PushChannel } from "@oguri/core";

/** What intake needs to call Feishu as the app. */
export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
  /** API base; https://open.feishu.cn by default, https://open.larksuite.com for Lark. */
  apiUrl?: string;
}

/** Feishu codes meaning the access token is missing, expired, or invalid. */
const TOKEN_ERRORS = new Set([99991661, 99991663, 99991664, 99991665, 99991668]);

/** A refused call. `code` is Feishu's own code, or null for an HTTP or transport failure. */
export class FeishuApiError extends Error {
  readonly code: number | null;
  readonly status: number | null;
  constructor(message: string, code: number | null, status: number | null) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
    this.status = status;
  }
  /** A failure worth retrying: rate limits, server errors, and a dropped connection. */
  get transient(): boolean {
    if (this.status === null && this.code === null) return true;
    if (this.status === 408 || this.status === 429) return true;
    if (this.status !== null && this.status >= 500) return true;
    // 99991400: request too frequent.
    return this.code === 99991400;
  }
}

export interface FeishuRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path under the API base, starting with `/open-apis/`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface FeishuClientOptions {
  timeoutMs?: number;
  tokens?: FeishuTokenCache;
  fetch?: typeof fetch;
}

export const DEFAULT_FEISHU_TIMEOUT_MS = 10_000;

/** One app's client. Cheap to create; the token cache is what carries state. */
export class FeishuClient {
  private readonly channel: PushChannel;
  private readonly tokens: FeishuTokenCache;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(credentials: FeishuAppCredentials, options: FeishuClientOptions = {}) {
    // The token cache is keyed on these fields of a push channel; the rest is unused.
    this.channel = {
      name: "intake",
      format: "feishu-app",
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      ...(credentials.apiUrl === undefined ? {} : { apiUrl: credentials.apiUrl }),
      events: ["needs-human"],
      maxPerHour: 1000,
    };
    this.tokens = options.tokens ?? new FeishuTokenCache();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FEISHU_TIMEOUT_MS;
    this.doFetch = options.fetch ?? fetch;
  }

  get apiBase(): string {
    return (this.channel.apiUrl ?? FEISHU_API).replace(/\/+$/, "");
  }

  /**
   * Call the API and return its `data`. Retries once with a fresh token when
   * Feishu reports the token invalid.
   * @throws FeishuApiError for a refused call or a transport failure.
   */
  async call<T = Record<string, unknown>>(request: FeishuRequest): Promise<T> {
    let token = await this.token();
    let reply = await this.send(request, token);
    if (reply.code !== null && TOKEN_ERRORS.has(reply.code)) {
      this.tokens.invalidate(this.channel);
      token = await this.token();
      reply = await this.send(request, token);
    }
    if (reply.code !== null && reply.code !== 0) {
      throw new FeishuApiError(
        `feishu ${request.path}: code ${String(reply.code)}`,
        reply.code,
        reply.status,
      );
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new FeishuApiError(
        `feishu ${request.path}: HTTP ${String(reply.status)}`,
        null,
        reply.status,
      );
    }
    return (reply.data ?? {}) as T;
  }

  private async token(): Promise<string> {
    try {
      return await this.tokens.get(this.channel, this.timeoutMs);
    } catch (error) {
      if (error instanceof Error) {
        const match = /code (\d+)/.exec(error.message);
        throw new FeishuApiError(
          `feishu token: ${error.message.replace(/^feishu-app token: /, "")}`,
          match === null ? null : Number(match[1]),
          null,
        );
      }
      throw error;
    }
  }

  private async send(
    request: FeishuRequest,
    token: string,
  ): Promise<{ status: number; code: number | null; data: unknown }> {
    const url = new URL(`${this.apiBase}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? `timed out after ${String(Math.round(this.timeoutMs / 1000))}s`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new FeishuApiError(`feishu ${request.path}: ${reason}`, null, null);
    }
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
    const code = payload?.["code"];
    // A few endpoints, such as `bot/v3/info`, answer beside `code` instead of
    // under `data`; hand those back without the envelope.
    const { code: _code, msg: _msg, data, ...rest } = payload ?? {};
    return {
      status: response.status,
      code: typeof code === "number" ? code : null,
      data: data ?? (Object.keys(rest).length === 0 ? undefined : rest),
    };
  }
}
