import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countWords, MAX_ACK_WORDS } from "../src/task-relay-tools.ts";

/** The acknowledgement limit is in words, and must hold for Chinese text too. */
describe("reply word count", () => {
  it("counts words separated by spaces", () => {
    assert.equal(countWords("On it: the cancel button."), 5);
    assert.equal(countWords("  spaced \n out\twords  "), 3);
    assert.equal(countWords(""), 0);
  });

  it("counts each Han or kana character as a word", () => {
    assert.equal(countWords("收到，马上处理"), 6);
    assert.equal(countWords("修复 cancel 按钮"), 5);
    assert.equal(countWords("了解しました"), 6);
  });

  it("holds a Chinese acknowledgement to the same limit", () => {
    assert.ok(countWords("好".repeat(MAX_ACK_WORDS + 1)) > MAX_ACK_WORDS);
  });
});
