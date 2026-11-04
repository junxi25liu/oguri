import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseContent } from "../src/feishu/content.ts";

/** Feishu message content as plain text, with the bot's own mention removed. */

const BOT = "ou_bot";
const mentions = [
  { key: "@_user_1", id: { open_id: BOT }, name: "Oguri" },
  { key: "@_user_2", id: { open_id: "ou_bob" }, name: "Bob" },
];

describe("parseContent", () => {
  it("resolves mentions in text, dropping the bot's and naming the rest", () => {
    const parsed = parseContent(
      "text",
      JSON.stringify({ text: "@_user_1 fix the cancel button, ask @_user_2 for review" }),
      mentions,
      BOT,
    );
    assert.equal(parsed.text, "fix the cancel button, ask @Bob for review");
    assert.equal(parsed.mentionsBot, true);
  });

  it("says the bot was not mentioned when only someone else was", () => {
    const parsed = parseContent(
      "text",
      JSON.stringify({ text: "@_user_2 lunch?" }),
      [mentions[1] as (typeof mentions)[number]],
      BOT,
    );
    assert.equal(parsed.text, "@Bob lunch?");
    assert.equal(parsed.mentionsBot, false);
  });

  it("accepts a mention id given as a plain string", () => {
    const parsed = parseContent(
      "text",
      JSON.stringify({ text: "@_user_1 hi" }),
      [{ key: "@_user_1", id: BOT, name: "Oguri" }],
      BOT,
    );
    assert.equal(parsed.mentionsBot, true);
    assert.equal(parsed.text, "hi");
  });

  it("concatenates a post's text nodes, line by line, with its title", () => {
    const post = {
      zh_cn: {
        title: "Checkout",
        content: [
          [
            { tag: "at", user_id: "@_user_1" },
            { tag: "text", text: " move the " },
            { tag: "a", text: "cancel button", href: "https://x" },
          ],
          [
            { tag: "img", image_key: "img_1" },
            { tag: "text", text: "to the left" },
          ],
        ],
      },
    };
    const parsed = parseContent("post", JSON.stringify(post), mentions, BOT);
    assert.equal(parsed.text, "Checkout\nmove the cancel button\nto the left");
    assert.equal(parsed.mentionsBot, true);
  });

  it("reads a post without a locale wrapper", () => {
    const post = { title: "", content: [[{ tag: "text", text: "plain post" }]] };
    assert.equal(parseContent("post", JSON.stringify(post), [], BOT).text, "plain post");
  });

  it("marks any other message type instead of guessing at its words", () => {
    assert.equal(
      parseContent("image", JSON.stringify({ image_key: "x" }), [], BOT).text,
      "[image message]",
    );
    assert.equal(parseContent("text", "not json", [], BOT).text, "[text message]");
  });
});
