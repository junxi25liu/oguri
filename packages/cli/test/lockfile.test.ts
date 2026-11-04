import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * The lockfile must resolve the native builds for every platform CI and the
 * release run on, not only the machine that last wrote it.
 *
 * TypeScript 7 and oxlint ship their compilers as per-platform optional
 * packages. An install that pruned them (an offline install does) still works
 * on the author's machine, so nothing failed locally while every clean Linux
 * checkout, including the release, could not build or lint.
 */
const LOCK = join(import.meta.dirname, "..", "..", "..", "pnpm-lock.yaml");

describe("pnpm-lock.yaml", () => {
  it("keeps the native packages for Linux and macOS", async () => {
    const lock = await readFile(LOCK, "utf8");
    for (const name of [
      "@typescript/typescript-linux-x64",
      "@typescript/typescript-darwin-arm64",
      "@oxlint/binding-linux-x64-gnu",
      "@oxlint/binding-darwin-arm64",
    ]) {
      assert.ok(lock.includes(`${name}@`), `${name} is missing from pnpm-lock.yaml`);
    }
  });
});
