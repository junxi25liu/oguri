import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { prepareWorkspace } from "../src/workspace.ts";

const exec = promisify(execFile);

describe("concurrent worktree creation", () => {
  let repo: string;
  let scratch: string;
  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "oguri-worktree-race-repo-"));
    scratch = await mkdtemp(join(tmpdir(), "oguri-worktree-race-runs-"));
    const git = (...args: string[]) =>
      exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args]);
    await git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(repo, "README"), "hello\n");
    await git("add", "README");
    await git("commit", "--quiet", "-m", "init");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  // git reads every worktree's admin directory while it adds one, so two `worktree add`
  // calls on one repository fail with "failed to read .../commondir" when they overlap.
  it("gives every concurrent run its own worktree of one repository", async () => {
    for (let round = 0; round < 2; round += 1) {
      const runs = Array.from({ length: 40 }, (_, i) => ({
        taskId: `TASK${String(round)}X${String(i)}`,
        runId: `RUN${String(round)}X${String(i)}`,
        runDir: join(scratch, `r${String(round)}`, String(i)),
      }));
      const settled = await Promise.allSettled(
        runs.map((run) => prepareWorkspace({ workdir: repo, worktree: true, ...run })),
      );
      const failures = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : []));
      assert.deepEqual(failures, [], `round ${String(round)}`);
    }
  });
});
