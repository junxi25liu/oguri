import { type Backend, openBackend } from "@oguri/daemon";

import { type Ctx, bool, str } from "./context.ts";

/**
 * Run against the daemon when one is listening, and directly otherwise.
 *
 * Preferring the daemon keeps inbox state single-writer and lets presence stay
 * accurate; direct mode means a stopped daemon never blocks a human (ADR 0005).
 *
 * A command is NOT a session by default. Only a command that keeps running —
 * `watch` — passes `session`, because the daemon publishes a presence
 * transition per session, and a one-shot command that declared one wrote `live`
 * and then `away` on `main` for every invocation.
 */
export async function withBackend(
  ctx: Ctx,
  fn: (backend: Backend) => Promise<number>,
  options: { session?: boolean } = {},
): Promise<number> {
  const network = str(ctx, "network");
  const backend = await openBackend({
    layout: ctx.layout,
    ...(network === undefined ? {} : { network }),
    ...(bool(ctx, "direct") ? { forceDirect: true } : {}),
    ...(options.session === undefined ? {} : { session: options.session }),
  });
  try {
    return await fn(backend);
  } finally {
    await backend.close();
  }
}

// `init` and `doctor` deliberately bypass `withBackend`: init runs before any
// network exists, and doctor must inspect the real local state rather than
// whatever a daemon reports about it.
