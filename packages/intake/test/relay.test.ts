import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WITHHELD_REPLY,
  composeReply,
  countWords,
  flattenText,
  limitWords,
  relaysFor,
} from "../src/relay.ts";
import { ORIGIN, TaskThread, Timeline } from "./room-fixture.ts";

/** The reply text guard and the relay-to-reply mapping (ADR 0030 §6). */

const TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}`;

describe("reply text", () => {
  it("counts CJK characters and other runs of non-space as words", () => {
    assert.equal(countWords("fix the login button"), 4);
    assert.equal(countWords("修好登录按钮"), 6);
    assert.equal(countWords("PR 已合并：https://github.com/a/b/pull/1"), 5);
    assert.equal(countWords("你好，世界！ — ok"), 5, "punctuation alone is not a word");
    assert.equal(countWords("ログイン修正"), 6);
  });

  it("cuts at the word limit with an ellipsis", () => {
    assert.equal(limitWords("one two three four", 2), "one two…");
    assert.equal(limitWords("one two", 2), "one two");
    assert.equal(limitWords("登录按钮已经修好了", 4), "登录按钮…");
    assert.equal(limitWords("已修复 the login 按钮", 4), "已修复 the…");

    const english = Array.from({ length: 150 }, (_, i) => `w${String(i)}`).join(" ");
    const cut = composeReply("result", english, { maxWords: 100 });
    assert.equal(countWords(cut), 100);
    assert.ok(cut.endsWith("w99…"));
    const chinese = "测".repeat(150);
    assert.equal(composeReply("result", chinese, { maxWords: 100 }), `${"测".repeat(100)}…`);
  });

  it("flattens whitespace and strips control and invisible characters", () => {
    assert.equal(flattenText("  line one\n\n\tline two  "), "line one line two");
    assert.equal(flattenText("bell\u0007 and \u001b[31mred"), "bell and [31mred");
    assert.equal(flattenText("a\u200Bb \u202Eevil\u202C c"), "ab evil c");
    assert.equal(
      flattenText("\u{1F468}\u200D\u{1F469}"),
      "\u{1F468}\u200D\u{1F469}",
      "the zero-width joiner in emoji stays",
    );
  });

  it("withholds a reply the secret scanner flags", () => {
    assert.equal(
      composeReply("result", `Done. Use token ${TOKEN} to deploy.`, { maxWords: 100 }),
      WITHHELD_REPLY,
    );
    // A secret split across lines is caught once the reply is flattened onto one.
    assert.equal(
      composeReply("answer", "password=\nhunter2-Very-Secret-9x", { maxWords: 100 }),
      WITHHELD_REPLY,
    );
    assert.equal(
      composeReply("answer", "password = hunter2-Very-Secret-9x", { maxWords: 100 }),
      WITHHELD_REPLY,
    );
  });

  it("says something when nothing is left", () => {
    assert.match(composeReply("result", " \n\u0000 ", { maxWords: 100 }), /Finished/);
  });
});

describe("relaysFor", () => {
  it("maps a relay message to a reply under the request", () => {
    const thread = new TaskThread(new Timeline()).run();
    const message = thread.say("On it: fixing the login button.", { relay: "ack" });
    const reply = relaysFor(message, { task: thread.task, thread: thread.thread });
    assert.deepEqual(reply, {
      key: `relay:${message.header.id}`,
      source: "feishu",
      conversation: ORIGIN.conversation,
      replyTo: ORIGIN.message,
      text: "On it: fixing the login button.",
      purpose: "ack",
      taskId: thread.task.id,
    });
  });

  it("puts an answer to a follow-up under the follow-up", () => {
    const thread = new TaskThread(new Timeline()).run();
    const question = thread.followup("Also the cancel button?", "om_question");
    const answer = thread.say("Yes, both buttons.", {
      relay: "answer",
      inReplyTo: question.header.id,
    });
    const reply = relaysFor(
      answer,
      { task: thread.task, thread: thread.thread },
      { parent: question },
    );
    assert.equal(reply?.replyTo, "om_question");
    assert.equal(reply?.conversation, ORIGIN.conversation);

    // Any other purpose, or an answer to an agent's message, goes under the request.
    const ack = thread.say("Got it.", { relay: "ack", inReplyTo: question.header.id });
    assert.equal(
      relaysFor(ack, { task: thread.task, thread: thread.thread }, { parent: question })?.replyTo,
      ORIGIN.message,
    );
    const plain = thread.say("Answering myself.", { relay: "answer" });
    assert.equal(
      relaysFor(plain, { task: thread.task, thread: thread.thread }, { parent: thread.root })
        ?.replyTo,
      ORIGIN.message,
    );
  });

  it("never relays the chat's own words back, nor a human-authored message", () => {
    const thread = new TaskThread(new Timeline()).run();
    const task = { task: thread.task, thread: thread.thread };
    const relayedIn = thread.say("please hurry", {
      relay: "answer",
      external: {
        source: "feishu",
        id: "om_x",
        conversation: ORIGIN.conversation,
        actor: "ou_alice",
        human: true,
      },
    });
    assert.equal(relaysFor(relayedIn, task), null);
    const human = thread.say("typed by a person", { relay: "answer", authorKind: "human" });
    assert.equal(relaysFor(human, task), null);
  });

  it("needs a relay purpose, an origin, and the task's own thread", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    const task = { task: thread.task, thread: thread.thread };
    assert.equal(relaysFor(thread.say("no purpose"), task), null);
    const elsewhere = thread.say("other thread", {
      relay: "result",
      thread: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    assert.equal(relaysFor(elsewhere, task), null);

    const local = new TaskThread(time, { origin: null }).run();
    const result = local.say("done", { relay: "result" });
    assert.equal(relaysFor(result, { task: local.task, thread: local.thread }), null);
  });

  it("applies the word limit and the secret guard", () => {
    const thread = new TaskThread(new Timeline()).run();
    const task = { task: thread.task, thread: thread.thread };
    const long = thread.say(Array.from({ length: 30 }, () => "word").join(" "), {
      relay: "result",
    });
    assert.equal(countWords(relaysFor(long, task, { maxReplyWords: 10 })?.text ?? ""), 10);
    const leaky = thread.say(`token ${TOKEN}`, { relay: "result" });
    assert.equal(relaysFor(leaky, task)?.text, WITHHELD_REPLY);
  });
});
