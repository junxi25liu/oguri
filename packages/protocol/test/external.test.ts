import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMessage,
  createTask,
  parseMessage,
  serializeMessage,
  ulid,
  type Task,
} from "../src/index.ts";
import { assertTaskTransition } from "../src/task.ts";

/** External references, relay purposes, task origin and mandate (ADR 0030). */

const ORIGIN = {
  source: "feishu",
  conversation: "oc_123",
  message: "om_456",
  thread: "omt_789",
  requester: "ou_abc",
  url: "https://example.feishu.cn/msg/om_456",
};
const MANDATE = { strength: "explicit", via: "addressed", policy: "0123abcd89ef4567" } as const;

describe("external references and relay purposes", () => {
  it("round-trips through the wire format", () => {
    const message = createMessage({
      id: ulid(),
      room: "ops",
      from: "intake-bot",
      authorKind: "human",
      kind: "msg",
      needs: "none",
      body: "也把取消按钮改一下",
      external: {
        source: "feishu",
        id: "om_1",
        conversation: "oc_1",
        thread: "omt_1",
        actor: "ou_1",
        actorName: "刘",
        human: true,
      },
      relay: "ack",
    });
    const parsed = parseMessage(serializeMessage(message));
    assert.deepEqual(parsed.header.external, message.header.external);
    assert.equal(parsed.header.relay, "ack");
    assert.deepEqual(parsed.header.extra, {});
  });

  it("reads a message without them exactly as before", () => {
    const message = createMessage({
      id: ulid(),
      room: "ops",
      from: "alice-claude",
      authorKind: "agent",
      kind: "msg",
      needs: "none",
      body: "hi",
    });
    const parsed = parseMessage(serializeMessage(message));
    assert.equal(parsed.header.external, undefined);
    assert.equal(parsed.header.relay, undefined);
  });

  it("refuses malformed fields", () => {
    const base = {
      id: ulid(),
      room: "ops",
      from: "intake-bot",
      authorKind: "human" as const,
      kind: "msg" as const,
      needs: "none" as const,
      body: "x",
    };
    assert.throws(() =>
      createMessage({ ...base, external: { source: "Feishu", id: "1", actor: "a", human: true } }),
    );
    assert.throws(() =>
      createMessage({
        ...base,
        external: { source: "feishu", id: "a\nb", actor: "a", human: true },
      }),
    );
    assert.throws(() => createMessage({ ...base, relay: "shout" as never }));
  });
});

describe("task origin and mandate", () => {
  it("round-trip on a task snapshot", () => {
    const task = createTask({
      id: ulid(),
      creator: "intake-bot",
      title: "Rename the save button",
      origin: ORIGIN,
      mandate: MANDATE,
    });
    const message = createMessage({
      id: ulid(),
      room: "ops",
      from: "intake-bot",
      authorKind: "agent",
      kind: "status",
      needs: "none",
      body: "",
      task,
    });
    const parsed = parseMessage(serializeMessage(message));
    assert.deepEqual(parsed.header.task?.origin, ORIGIN);
    assert.deepEqual(parsed.header.task?.mandate, MANDATE);
  });

  it("are fixed at creation", () => {
    const created = createTask({
      id: ulid(),
      creator: "intake-bot",
      title: "t",
      origin: ORIGIN,
      mandate: MANDATE,
    });
    const claimed: Task = {
      ...created,
      action: "claimed",
      state: "claimed",
      assignee: "bob-claude",
      attempt: 1,
    };
    assertTaskTransition(created, claimed, "bob-claude");
    const { origin: _origin, ...withoutOrigin } = claimed;
    assert.throws(() => assertTaskTransition(created, withoutOrigin, "bob-claude"), /origin/);
    assert.throws(
      () =>
        assertTaskTransition(
          created,
          { ...claimed, mandate: { ...MANDATE, strength: "inferred" } },
          "bob-claude",
        ),
      /mandate/,
    );
  });

  it("refuses a malformed mandate or origin", () => {
    const base = { id: ulid(), creator: "intake-bot", title: "t" };
    assert.throws(() => createTask({ ...base, mandate: { ...MANDATE, policy: "XYZ" } }));
    assert.throws(() => createTask({ ...base, origin: { ...ORIGIN, url: "javascript:x" } }));
    assert.throws(() => createTask({ ...base, origin: { ...ORIGIN, conversation: "" } }));
  });
});
