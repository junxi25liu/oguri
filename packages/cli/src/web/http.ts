/**
 * The bind and request guards shared by the dashboard and the chat page.
 *
 * Both HTTP surfaces must make the same decision about which hosts are local,
 * and whether an `Authorization` header carries the exact configured token.
 * Keeping these helpers apart from the server also avoids a runtime import
 * cycle: `server.ts` calls the chat handler, and the handler needs these guards.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const DEFAULT_WEB_PORT = 7380;
export const DEFAULT_WEB_HOST = "127.0.0.1";

export interface BindPlan {
  host: string;
  port: number;
  /** Null means no token is required: loopback with none given. */
  token: string | null;
  /** True when the token was generated here and must be shown to the user. */
  generated: boolean;
}

/** Whether a host string names this machine's loopback interface. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  return isIP(bare) === 4 && bare.startsWith("127.");
}

/** Host header without the port, or null when absent. */
export function hostName(req: IncomingMessage): string | null {
  const raw = req.headers.host;
  if (raw === undefined) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(raw);
  return match === null ? null : (match[1] as string);
}

/** Constant-time comparison of an `Authorization` header against the token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (match === null) return false;
  const given = createHash("sha256")
    .update(match[1] as string)
    .digest();
  const wanted = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, wanted);
}
