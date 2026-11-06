import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeJson, parseClaudeStream } from "../src/session.ts";

const stream = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("model evidence provenance", () => {
  it("never treats CLI init as a response model", () => {
    const read = parseClaudeStream(stream({ type: "system", subtype: "init", model: "requested" }));
    assert.equal(read.model, undefined);
    assert.equal(read.modelInitialized, "requested");
  });

  it("reads the nested assistant label without replacing it with highest-cost usage", () => {
    const read = parseClaudeStream(
      stream(
        { type: "system", subtype: "init", model: "requested" },
        { type: "assistant", message: { model: "response-alias" } },
        {
          type: "result",
          result: "ok",
          modelUsage: { expensive: { costUSD: 10 }, "response-alias": { costUSD: 1 } },
        },
      ),
    );
    assert.equal(read.model, "response-alias");
    assert.equal(read.modelSource, "assistant-message");
    assert.equal(read.modelInitialized, "requested");
    assert.deepEqual(read.modelsUsage, ["expensive", "response-alias"]);
  });

  it("keeps multiple usage labels without claiming a single model", () => {
    const read = parseClaudeJson(
      JSON.stringify({ type: "result", modelUsage: { a: { costUSD: 1 }, b: { costUSD: 100 } } }),
    );
    assert.equal(read.model, undefined);
    assert.deepEqual(read.modelsUsage, ["a", "b"]);
  });

  it("labels a sole usage model as usage, not as an assistant response", () => {
    const read = parseClaudeJson(
      JSON.stringify({ type: "result", modelUsage: { a: { costUSD: 1 } } }),
    );
    assert.equal(read.model, "a");
    assert.equal(read.modelSource, "result-usage");
  });

  it("reads evidence from JSON event arrays as well as JSON lines", () => {
    const read = parseClaudeJson(
      JSON.stringify([
        { type: "system", subtype: "init", model: "requested", session_id: "s1" },
        { type: "assistant", message: { model: "actual-label" } },
        { type: "result", session_id: "s1", result: "done" },
      ]),
    );
    assert.equal(read.model, "actual-label");
    assert.equal(read.modelSource, "assistant-message");
    assert.equal(read.text, "done");
  });

  it("ignores non-object JSON and unsafe model labels", () => {
    const read = parseClaudeStream(
      stream(null, 1, { type: "assistant", message: { model: "--unsafe" } }),
    );
    assert.deepEqual(read, {});
  });
});
