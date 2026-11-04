import { type ResumePoint, type TransportHealth } from "@oguri/core";
import { type Backend } from "@oguri/daemon";
import {
  ago,
  bold,
  dim,
  errline,
  green,
  json,
  out,
  red,
  renderInbox,
  renderInboxBrief,
  yellow,
} from "../output.ts";

import { type Ctx, bool, list, str } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export interface InboxRow {
  id: string;
  room: string;
  from: string;
  ts: string;
  kind: string;
  needs: string;
  priority: string;
  thread: string;
  tags: string[];
  path: string;
  body: string;
  processedAt: string | null;
}

/**
 * Which networks one read covers: the bound one, or every configured one.
 *
 * An agent waiting for work should not have to know which transport repo the
 * answer will arrive on. `--all-networks` is what makes "am I needed" a
 * question about this agent rather than about a network it had to pick first.
 */
export async function readScope(ctx: Ctx, be: Backend): Promise<(string | undefined)[]> {
  if (!bool(ctx, "all-networks")) return [undefined];
  const networks = await be.networks().catch(() => []);
  return networks.length === 0 ? [undefined] : networks.map((net) => net.id);
}

/**
 * One inbox view over every configured network.
 *
 * Each row carries the network it came from, because acting on it means
 * answering there — and a merged list that hid which repo an item belonged to
 * would be a worse lie than the per-network view it replaces. Health travels
 * per network too: one unreachable transport must not make the others look
 * quiet, and it must not make this read fail either.
 */
async function inboxAcrossNetworks(
  ctx: Ctx,
  be: Backend,
  networks: (string | undefined)[],
  query: Record<string, unknown>,
): Promise<number> {
  const sections = await Promise.all(
    networks.map(async (network) => {
      const [health, items] = await Promise.all([
        be.call<TransportHealth>("health", {}, network).catch(() => null),
        be.call<InboxRow[]>("inbox", query, network).catch(() => [] as InboxRow[]),
      ]);
      return { network: network ?? "?", health, items };
    }),
  );

  if (bool(ctx, "json")) {
    json({ networks: sections });
    return 0;
  }
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  for (const section of sections) {
    if (section.health?.degraded === true) {
      errline(`${yellow("!")} ${section.network}: ${renderDegraded(section.health)}`);
    }
    if (section.items.length === 0) continue;
    out(bold(`${section.network}`));
    renderInbox(section.items);
    out();
  }
  if (total === 0) {
    out(dim(`inbox empty across ${String(sections.length)} network(s)`));
    out(dim("  oguri mentions — messages naming you in rooms you have not joined"));
  }
  return 0;
}

export async function cmdInbox(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const needs = str(ctx, "needs");
  const tag = list(ctx, "tag")[0];

  return await withBackend(ctx, async (be) => {
    const scope = await readScope(ctx, be);
    const query = {
      ...(room === undefined ? {} : { room }),
      ...(needs === undefined ? {} : { needs }),
      ...(tag === undefined ? {} : { tag }),
    };
    if (scope.length > 1) return await inboxAcrossNetworks(ctx, be, scope, query);

    const [health, items] = await Promise.all([
      be.call<TransportHealth>("health"),
      be.call<InboxRow[]>("inbox", query),
    ]);
    // Said before the list, not after: an empty inbox from a broken transport
    // is the one output a reader must not take at face value.
    if (health.degraded && !bool(ctx, "json")) errline(renderDegraded(health));

    if (bool(ctx, "drain")) {
      const result = await be.call<{ drained: number; refused: string[] }>("inboxDrain", {
        ids: items.map((i) => i.id),
        rooms: [...new Set(items.map((i) => i.room))],
      });
      if (bool(ctx, "json")) {
        json({
          health,
          drained: result.drained,
          messages: items.filter((i) => i.needs !== "human"),
          awaitingHuman: items.filter((i) => i.needs === "human"),
        });
      } else {
        renderInbox(items);
        out();
        out(green(`✓ drained ${String(result.drained)}`));
        if (result.refused.length > 0) {
          out(
            red(
              `  ${String(result.refused.length)} left pending — 'needs: human' items require a person.`,
            ),
          );
        }
      }
      return 0;
    }

    if (bool(ctx, "json")) json({ health, items });
    else if (bool(ctx, "brief")) {
      // The brief is what a SessionStart hook injects, so it leads with the
      // work this agent already had in flight rather than with other agents'
      // mail. A room that will not open must not cost the session its mail, so
      // an unreadable agenda degrades to the mail alone.
      const resume = await be.call<ResumePoint[]>("resume", {}).catch(() => []);
      renderInboxBrief(items, resume);
    } else renderInbox(items);
    return 0;
  });
}

/**
 * The warning shown when the local view cannot be trusted.
 *
 * Names what to do, because "degraded" alone leaves a reader guessing whether
 * an empty inbox means quiet or broken — which is the confusion this exists to
 * end.
 */
export function renderDegraded(health: TransportHealth): string {
  const age =
    health.ageSeconds === null ? "never synced" : `last synced ${ago(health.lastSyncAt as string)}`;
  const since = health.failingSince === undefined ? "" : ` since ${ago(health.failingSince)}`;
  return (
    yellow(`! this view may be incomplete — ${age}`) +
    (health.reason === undefined ? "" : `\n  ${dim(`sync failing${since}: ${health.reason}`)}`) +
    `\n  ${dim("an empty list here means nothing reached this machine, not that nothing was said")}` +
    `\n  ${dim("check the transport: oguri doctor")}`
  );
}
