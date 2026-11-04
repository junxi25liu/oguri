import { type ClaimStatus } from "@oguri/core";
import { assertRoomId } from "@oguri/protocol";
import { ago, bold, cyan, dim, errline, green, json, out, yellow } from "../output.ts";

import { type Ctx, bool, num, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

/**
 * Take, release, or inspect an advisory lease on a shared resource.
 *
 * Replaces the "BUILD-START … BUILD-DONE" convention two agents invented out of
 * chat messages: same idea, but the hold expires on its own and the answer to
 * "did I get it?" is checked rather than assumed.
 */
export async function cmdClaim(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === "release") {
    const room = ctx.positionals[2];
    const resource = ctx.positionals[3];
    if (room === undefined || resource === undefined) {
      usage("claim release needs <room> <resource>");
    }
    assertRoomId(room);
    return await withBackend(ctx, async (be) => {
      const { released } = await be.call<{ released: boolean }>("claimRelease", { room, resource });
      if (bool(ctx, "json")) json({ resource, released });
      else out(released ? green(`✓ released ${resource}`) : dim(`you do not hold ${resource}`));
      return 0;
    });
  }

  const room = ctx.positionals[1];
  const resource = ctx.positionals[2];
  if (room === undefined || resource === undefined) {
    usage("claim needs <room> <resource> [note] — or: claim release <room> <resource>");
  }
  assertRoomId(room);
  const note = ctx.positionals.slice(3).join(" ");
  const ttlSeconds = num(ctx, "ttl");

  return await withBackend(ctx, async (be) => {
    const result = await be.call<{ granted: boolean; status: ClaimStatus | null }>("claim", {
      room,
      resource,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      ...(note === "" ? {} : { note }),
    });
    if (bool(ctx, "json")) {
      json(result);
      return result.granted ? 0 : 5;
    }
    if (result.granted) {
      out(green(`✓ holding ${resource}`) + dim(` until ${result.status?.expiresAt ?? "?"}`));
      out(dim(`  release it when done: oguri claim release ${room} ${resource}`));
      return 0;
    }
    // Exit 5, distinct from a failure: not getting a lock is a normal outcome
    // an agent must branch on, not an error it should retry blindly.
    errline(yellow(`✗ ${resource} is held by ${result.status?.holder ?? "another agent"}`));
    if (result.status !== null) {
      errline(dim(`  since ${ago(result.status.since)}, expires ${result.status.expiresAt}`));
      if (result.status.note !== "") errline(dim(`  "${result.status.note}"`));
    }
    errline(dim("  wait for it to be released or to expire; do not proceed in parallel"));
    return 5;
  });
}

export async function cmdClaims(ctx: Ctx): Promise<number> {
  const room = ctx.positionals[1];
  if (room === undefined) usage("claims needs a room");
  assertRoomId(room);
  return await withBackend(ctx, async (be) => {
    const claims = await be.call<ClaimStatus[]>("claims", { room });
    const live = claims.filter((claim) => !claim.expired);
    if (bool(ctx, "json")) {
      json(live);
      return 0;
    }
    if (live.length === 0) {
      out(dim(`nothing is claimed in ${room}`));
      return 0;
    }
    for (const claim of live) {
      out(
        `${bold(claim.resource.padEnd(28))} ${cyan(claim.holder.padEnd(18))} ` +
          dim(`since ${ago(claim.since)} · expires ${claim.expiresAt}`),
      );
      if (claim.note !== "") out(dim(`  ${claim.note}`));
      if (claim.contenders.length > 0) {
        out(yellow(`  waiting: ${claim.contenders.join(", ")}`));
      }
    }
    return 0;
  });
}
