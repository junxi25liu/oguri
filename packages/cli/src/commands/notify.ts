import { describePushTarget, loadLocalPolicy } from "@oguri/core";
import { sendPush, testPushEvent } from "@oguri/daemon";

import { type Ctx, bool, str, usage } from "../context.ts";
import { bold, cyan, dim, green, json, out, red } from "../output.ts";

/**
 * `oguri notify [test]` — the push channels in the local policy (ADR 0028).
 *
 * Runs in this process, never through the daemon: a test is the moment a
 * person wants to see the real error from the real endpoint, and the channels
 * come from a machine-local file either way.
 */
export async function cmdNotify(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";
  switch (sub) {
    case "list":
      return await listChannels(ctx);
    case "test":
      return await testChannels(ctx);
    default:
      usage(`unknown notify subcommand '${sub}'; use list or test`);
  }
}

async function listChannels(ctx: Ctx): Promise<number> {
  const { policy, sources } = await loadLocalPolicy(ctx.layout);
  const channels = policy.notifications.channels;
  if (bool(ctx, "json")) {
    // Targets only: URLs and tokens are credentials.
    json(
      channels.map((channel) => ({
        name: channel.name,
        format: channel.format,
        target: describePushTarget(channel),
        events: channel.events,
        maxPerHour: channel.maxPerHour,
      })),
    );
    return 0;
  }
  if (channels.length === 0) {
    out(dim("no push channels configured"));
    out(dim(`  add a 'notifications.channels' section to ${ctx.layout.policyPath}`));
    out(dim("  start from a commented template with: oguri policy --init"));
    return 0;
  }
  for (const channel of channels) {
    out(
      `${bold(channel.name.padEnd(12))} ${cyan(describePushTarget(channel))}  ` +
        `${channel.events.join(", ")} ${dim(`· ${String(channel.maxPerHour)}/hour`)}`,
    );
  }
  out(dim(`from: ${sources.join(", ")}`));
  return 0;
}

async function testChannels(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const wanted = str(ctx, "channel");
  const all = policy.notifications.channels;
  const channels = wanted === undefined ? all : all.filter((c) => c.name === wanted);
  if (channels.length === 0) {
    if (wanted !== undefined) {
      usage(
        `no push channel named '${wanted}'` +
          (all.length === 0 ? "" : `; configured: ${all.map((c) => c.name).join(", ")}`),
      );
    }
    out(red("no push channels configured"));
    out(dim(`  add a 'notifications.channels' section to ${ctx.layout.policyPath}`));
    return 1;
  }

  const event = testPushEvent(ctx.config.agent.id, ctx.config.defaultNetwork ?? "oguri");
  const results = await Promise.all(channels.map((channel) => sendPush(channel, event)));
  if (bool(ctx, "json")) {
    json(results);
  } else {
    for (const [index, result] of results.entries()) {
      const channel = channels[index];
      const target = channel === undefined ? "" : dim(` ${describePushTarget(channel)}`);
      out(
        result.ok
          ? `${green("✓")} ${result.channel}${target}`
          : `${red("✗")} ${result.channel}${target} ${red(result.error ?? "failed")}`,
      );
    }
  }
  return results.every((result) => result.ok) ? 0 : 1;
}
