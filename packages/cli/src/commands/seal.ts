import { assertRoomId } from "@oguri/protocol";
import { dim, green, json, out, yellow } from "../output.ts";

import { type Ctx, bool, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

interface SealOutcome {
  roomId: string;
  sealed: number;
  kept: number;
  digest: string | null;
  digests?: string[];
  decisionsPromoted: number;
  skipped?: string;
}

export async function cmdSeal(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("seal needs a room");
  assertRoomId(roomId);

  return await withBackend(ctx, async (be) => {
    if (bool(ctx, "check")) {
      const decision = await be.call<{
        shouldSeal: boolean;
        reason: string;
        keeping: number;
        toSeal: unknown[];
      }>("sealCheck", { room: roomId });
      if (bool(ctx, "json")) {
        // toSeal carries whole messages; a summary is what a caller wants here.
        json({
          room: roomId,
          shouldSeal: decision.shouldSeal,
          reason: decision.reason,
          wouldSeal: decision.toSeal.length,
          keeping: decision.keeping,
        });
        return 0;
      }
      out(
        decision.shouldSeal
          ? `${yellow("due")} ${decision.reason} · keeping ${String(decision.keeping)}`
          : `${green("not due")} ${dim(decision.reason)}`,
      );
      return 0;
    }

    const result = await be.call<SealOutcome>("seal", { room: roomId });
    if (bool(ctx, "json")) {
      json(result);
      return 0;
    }
    if (result.sealed === 0) {
      out(dim(`nothing sealed — ${result.skipped ?? "nothing outside the window"}`));
      return 0;
    }
    out(
      green(`✓ sealed ${String(result.sealed)} message(s)`) +
        dim(` · keeping ${String(result.kept)}`),
    );
    const digests = result.digests ?? (result.digest === null ? [] : [result.digest]);
    for (const digest of digests) out(`  digest    ${digest}`);
    if (result.decisionsPromoted > 0) {
      out(`  decisions ${String(result.decisionsPromoted)} promoted (never pruned)`);
    }
    out(dim(`  the sealed messages remain in git history: oguri history ${roomId}`));
    return 0;
  });
}
