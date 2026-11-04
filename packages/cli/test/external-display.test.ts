import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

import { externalMark, originLines, relayMark } from "../src/external-display.ts";

/**
 * Chat-origin tasks and relayed chat messages (ADR 0030), as the CLI shows
 * them: who in the chat spoke, what a reply is for, and where a task came from.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const ORIGIN = {
  source: "feishu",
  conversation: "oc_team",
  message: "om_request",
  thread: "omt_1",
  requester: "ou_alice",
  url: "https://example.feishu.cn/messages/om_request",
};
const MANDATE = { strength: "explicit", via: "addressed", policy: "0123abcd0123abcd" } as const;

describe("external display", () => {
  it("marks a relayed message with the source and the person's name", () => {
    const external = { source: "feishu", id: "om_1", actor: "ou_alice", human: true };
    assert.equal(externalMark({ ...external, actorName: "Alice" }), "[feishu · Alice]");
    assert.equal(externalMark(external), "[feishu · ou_alice]", "the actor id when no name");
  });

  it("tags a relay purpose, and nothing for a message that goes nowhere", () => {
    assert.equal(relayMark({ relay: "ack" }), "relay:ack");
    assert.equal(relayMark({}), null);
  });

  it("prints origin and mandate, and nothing for an ordinary task", () => {
    assert.deepEqual(originLines({ origin: ORIGIN, mandate: MANDATE }), [
      "origin   feishu · conversation oc_team · requested by ou_alice",
      "         thread omt_1",
      "         https://example.feishu.cn/messages/om_request",
      "mandate  explicit · via addressed · policy 0123abcd0123abcd",
    ]);
    assert.deepEqual(originLines({}), []);
  });
});

describe("chat-origin tasks, through the built binary", () => {
  let tmp: string;
  let home: string;
  let taskId: string;
  let root: string;

  const oguri = async (...args: string[]): Promise<string> =>
    (
      await exec(process.execPath, [CLI, ...args, "--direct"], {
        env: testEnv({ OGURI_HOME: home, NO_COLOR: "1" }),
      })
    ).stdout;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oguri-external-"));
    home = join(tmp, "intake");
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    await oguri("init", "--repo", remote, "--network", "acme", "--agent", "intake-bot");
    await oguri("room", "create", "ops");

    // Written the way intake writes them: a task with an origin, then the
    // person's follow-up relayed with `external`, then a reply to the chat.
    const { Layout, Network, loadConfig, resolveNetwork } = await import("@oguri/core");
    const layout = new Layout(home);
    const config = (await loadConfig(layout.configPath)) as NonNullable<
      Awaited<ReturnType<typeof loadConfig>>
    >;
    const network = Network.open(layout, resolveNetwork(config), config.agent);
    try {
      const created = await network.createTask("ops", {
        title: "Fix the cancel button",
        definition: "The cancel button does nothing.",
        origin: ORIGIN,
        mandate: MANDATE,
      });
      taskId = created.header.task?.id as string;
      root = created.header.id;
      const followup = await network.send("ops", {
        body: "Also grey it out while saving.",
        inReplyTo: root,
        external: {
          source: "feishu",
          id: "om_followup",
          conversation: "oc_team",
          actor: "ou_alice",
          actorName: "Alice",
          human: true,
        },
      });
      await network.send("ops", {
        body: "Will do.",
        inReplyTo: followup.header.id,
        relay: "ack",
      });
    } finally {
      network.close();
    }
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("task show prints where the task came from and why it may be done", async () => {
    const shown = await oguri("task", "show", "ops", taskId);
    assert.match(shown, /origin {3}feishu · conversation oc_team · requested by ou_alice/);
    assert.match(shown, /https:\/\/example\.feishu\.cn\/messages\/om_request/);
    assert.match(shown, /mandate {2}explicit · via addressed · policy 0123abcd0123abcd/);
  });

  it("task show --json carries origin and mandate as they are", async () => {
    const detail = JSON.parse(await oguri("task", "show", "ops", taskId, "--json")) as {
      task: { origin: unknown; mandate: unknown };
    };
    assert.deepEqual(detail.task.origin, ORIGIN);
    assert.deepEqual(detail.task.mandate, MANDATE);
  });

  it("read marks the person who spoke in the chat, and the relay purpose", async () => {
    const read = await oguri("read", "ops", "--thread", root);
    assert.match(read, /intake-bot \[feishu · Alice\] .*Also grey it out/s);
    assert.match(read, /· msg relay:ack/);
  });

  it("read --json carries external and relay as they are", async () => {
    const messages = JSON.parse(await oguri("read", "ops", "--thread", root, "--json")) as {
      external: { actorName?: string; human: boolean } | null;
      relay: string | null;
    }[];
    const relayed = messages.find((m) => m.external !== null);
    assert.equal(relayed?.external?.actorName, "Alice");
    assert.equal(relayed?.external?.human, true);
    assert.equal(messages.find((m) => m.relay !== null)?.relay, "ack");
    assert.ok(
      messages.every((m) => "external" in m && "relay" in m),
      "always present, null if none",
    );
  });
});
