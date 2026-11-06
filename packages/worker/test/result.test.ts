import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { buildReport } from "../src/outcome.ts";
import {
  RESULT_FILE_LIMIT,
  readResult,
  resultFooter,
  resultRefs,
  validateResult,
} from "../src/result.ts";
import { runExecutor } from "../src/runner.ts";
import { listRuns } from "../src/runs.ts";
import { Worker } from "../src/worker.ts";
import { ME, ORIGIN, fakeBackend, policy, result } from "./fake-backend.ts";

const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}`;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-worker-result-"));
});

describe("result.json schema", () => {
  it("accepts the documented shape and nothing else", () => {
    assert.deepEqual(
      validateResult({
        summary: "  Fixed the login test.  ",
        branch: "fix/login",
        pr: "https://github.com/acme/app/pull/7",
        artifacts: ["out/report.html", "out/report.html"],
      }),
      {
        summary: "Fixed the login test.",
        branch: "fix/login",
        pr: "https://github.com/acme/app/pull/7",
        artifacts: ["out/report.html"],
      },
    );
    const refused = (value: unknown, pattern: RegExp) => {
      const verdict = validateResult(value);
      assert.equal(typeof verdict, "string", JSON.stringify(value));
      assert.match(verdict as string, pattern);
    };
    refused([], /not a JSON object/);
    refused({}, /"summary" must be a non-empty string/);
    refused({ summary: "   " }, /"summary"/);
    refused({ summary: "x", extra: 1 }, /unknown key\(s\): extra/);
    refused({ summary: "x", branch: "-delete" }, /"branch"/);
    refused({ summary: "x", branch: "a..b" }, /"branch"/);
    refused({ summary: "x", branch: "has space" }, /"branch"/);
    refused({ summary: "x", pr: "http://example.com/pr/1" }, /https URL/);
    refused({ summary: "x", pr: "https://user:pw@example.com/pr/1" }, /https URL/);
    refused({ summary: "x", pr: "https://" }, /https URL/);
    refused({ summary: "x", pr: "" }, /https URL/);
    refused({ summary: "x", artifacts: "a.txt" }, /"artifacts"/);
    refused({ summary: "x", artifacts: ["a\nb"] }, /single-line/);
    refused({ summary: "x", needsHuman: "" }, /"needsHuman"/);
  });

  it("accepts only noop as an outcome and rejects the whole file for other values", async () => {
    assert.deepEqual(validateResult({ summary: "Checked it.", outcome: "noop" }), {
      summary: "Checked it.",
      outcome: "noop",
    });
    const path = join(home, "result.json");
    for (const outcome of ["completed", "failed", "", "NOOP", null, 0, false, [], {}]) {
      const value = { summary: "Checked it.", outcome };
      assert.equal(validateResult(value), '"outcome" must be "noop"');
      await writeFile(path, JSON.stringify(value));
      assert.deepEqual(await readResult(path), {
        kind: "invalid",
        reason: '"outcome" must be "noop"',
      });
    }
  });

  it("accepts a run with no pull request, and reads null as 'left out'", () => {
    // JSON has no undefined: an agent with no PR writes null as often as nothing.
    assert.deepEqual(validateResult({ summary: "Done it." }), { summary: "Done it." });
    assert.deepEqual(
      validateResult({ summary: "Done it.", pr: null, branch: null, artifacts: null }),
      { summary: "Done it." },
    );
    assert.deepEqual(
      validateResult({ summary: "Half done.", pr: null, needsHuman: "Which table?" }),
      { summary: "Half done.", needsHuman: "Which table?" },
    );
    // null is forgiven only for an optional field; a missing summary is still refused.
    assert.equal(typeof validateResult({ summary: null, pr: null }), "string");
  });

  it("reads only a small regular file of valid JSON", async () => {
    const path = join(home, "result.json");
    assert.deepEqual(await readResult(path), { kind: "absent" });

    await writeFile(path, "{not json");
    assert.deepEqual(await readResult(path), { kind: "invalid", reason: "it is not valid JSON" });

    await writeFile(path, JSON.stringify({ summary: "x".repeat(RESULT_FILE_LIMIT) }));
    assert.deepEqual(await readResult(path), {
      kind: "invalid",
      reason: "it is larger than 64 KiB",
    });

    // A symlink could point the worker at any file this user can read.
    const secret = join(home, "secret.json");
    await writeFile(secret, JSON.stringify({ summary: "private" }));
    const link = join(home, "link.json");
    await symlink(secret, link);
    assert.deepEqual(await readResult(link), {
      kind: "invalid",
      reason: "it is not a regular file",
    });

    await writeFile(path, JSON.stringify({ summary: "ok" }));
    assert.deepEqual(await readResult(path), { kind: "valid", result: { summary: "ok" } });
  });

  it("turns branch, PR, and artifacts into refs, and drops a flagged ref", () => {
    const { refs, dropped } = resultRefs({
      result: {
        summary: "x",
        branch: "fix/login",
        pr: "https://github.com/acme/app/pull/7",
        artifacts: ["out/a.txt", "/tmp/b.txt", `out/${TOKEN}.txt`],
      },
      worktreeBranch: "oguri/T-R",
      machine: "build-01",
      cwd: "/work",
    });
    assert.deepEqual(refs, [
      "branch:oguri/T-R",
      "branch:fix/login",
      "https://github.com/acme/app/pull/7",
      "artifact:build-01:/work/out/a.txt",
      "artifact:build-01:/tmp/b.txt",
    ]);
    assert.equal(dropped, 1);
  });

  it("names the file and the variable in the prompt footer", () => {
    const footer = resultFooter("/runs/T/R/result.json");
    assert.match(footer, /\/runs\/T\/R\/result\.json/);
    assert.match(footer, /\$OGURI_RESULT_FILE/);
    assert.match(footer, /"summary"/);
  });

  it("does not put a pr field in front of a run that has no pull request", () => {
    // The template is copied verbatim by agents that have nothing to put there,
    // so showing `pr` is an invitation to write `"pr": null` or a placeholder.
    const footer = resultFooter("/runs/T/R/result.json");
    assert.doesNotMatch(footer, /"pr":/);
    assert.match(footer, /Add "pr" only when there is a pull request/);
    assert.match(footer, /do not write null/);
  });
});

describe("the prompt footer for a runner that requires the file", () => {
  it("says the file is required, and keeps the optional wording otherwise", () => {
    assert.match(resultFooter("/runs/T/R/result.json", true), /requires this file/);
    assert.doesNotMatch(resultFooter("/runs/T/R/result.json", true), /Without the file/);
    assert.match(resultFooter("/runs/T/R/result.json"), /Without the file/);
    assert.doesNotMatch(resultFooter("/runs/T/R/result.json"), /requires this file/);
  });
});

describe("reports from a result", () => {
  const base = {
    runner: "claude",
    attempt: 1,
    policy: { timeoutMinutes: 60, retry: { backoffMinutes: 10 } },
    where: `${ME}:/runs/T/R`,
    machine: "build-01",
    cwd: "/work",
  };

  it("uses the structured summary instead of the output tail", () => {
    const report = buildReport({
      ...base,
      result: result({ stdoutTail: "spinner noise" }),
      read: {
        kind: "valid",
        result: { summary: "Fixed it.", pr: "https://github.com/acme/app/pull/7" },
      },
    });
    assert.equal(report.action, "completed");
    assert.match(report.body, /Fixed it\./);
    assert.doesNotMatch(report.body, /spinner noise/);
    assert.deepEqual(report.refs, ["https://github.com/acme/app/pull/7"]);
  });

  it("completes a noop result with a No change needed summary prefix", () => {
    const report = buildReport({
      ...base,
      result: result(),
      read: {
        kind: "valid",
        result: { summary: "The settings are already correct.", outcome: "noop" },
      },
    });
    assert.equal(report.action, "completed");
    assert.equal(report.needsHuman, false);
    assert.match(report.body, /\n\nNo change needed: The settings are already correct\./);
  });

  it("does not let noop override failure or a question for a person", () => {
    const failed = buildReport({
      ...base,
      result: result({ exitCode: 1 }),
      read: { kind: "valid", result: { summary: "Checked it.", outcome: "noop" } },
    });
    assert.equal(failed.action, "blocked");
    const asking = buildReport({
      ...base,
      result: result(),
      read: {
        kind: "valid",
        result: { summary: "Checked it.", outcome: "noop", needsHuman: "Which environment?" },
      },
    });
    assert.equal(asking.action, "blocked");
    assert.equal(asking.needsHuman, true);
  });

  it("withholds a structured summary the secret scanner flags", () => {
    const report = buildReport({
      ...base,
      result: result(),
      read: { kind: "valid", result: { summary: `token ${TOKEN}` } },
    });
    assert.match(report.body, /Summary withheld/);
    assert.doesNotMatch(report.body, /ghp_/);
  });

  it("falls back to the output tail and says why when result.json is rejected", () => {
    const report = buildReport({
      ...base,
      result: result({ stdoutTail: "patched 3 files" }),
      read: { kind: "invalid", reason: "it is not valid JSON" },
    });
    assert.match(report.body, /result\.json was rejected: it is not valid JSON/);
    assert.match(report.body, /patched 3 files/);
  });

  it("never completes a task whose result.json was rejected, whatever the exit code", () => {
    for (const exitCode of [0, 1]) {
      const report = buildReport({
        ...base,
        attempt: 1,
        maxAttempts: 3,
        result: result({ exitCode }),
        read: { kind: "invalid", reason: "unknown key(s): pr_url" },
      });
      assert.equal(report.action, "released", `exit ${String(exitCode)}`);
      assert.match(report.body, /result\.json was rejected: unknown key\(s\): pr_url/);
      assert.match(report.body, /Released for another try/);
      // Exit 0 is the case that used to complete the task: it must say so.
      assert.equal(
        /not reported as a completion/.test(report.body),
        exitCode === 0,
        "only a run that exited 0 would otherwise have been reported as done",
      );
      assert.doesNotMatch(report.body, /^Done by worker/);
    }
  });

  it("blocks with the rejection reason once a rejected run has no attempts left", () => {
    const report = buildReport({
      ...base,
      attempt: 3,
      maxAttempts: 3,
      result: result({ exitCode: 0 }),
      read: { kind: "invalid", reason: '"pr" must be an https URL' },
    });
    assert.equal(report.action, "blocked");
    assert.equal(report.needsHuman, true);
    assert.match(report.body, /the run's result\.json was rejected/);
    assert.match(report.body, /"pr" must be an https URL/);
  });

  it("reports a rejected result through the retry rules, like a failed run with no attempts", () => {
    const report = buildReport({
      ...base,
      result: result({ exitCode: 0 }),
      read: { kind: "invalid", reason: "it is not a regular file" },
    });
    assert.equal(report.action, "blocked");
    assert.equal(report.needsHuman, false);
    assert.match(report.body, /Blocked: the run's result\.json was rejected/);
  });

  it("still completes a clean run with no pull request", () => {
    const report = buildReport({
      ...base,
      result: result(),
      read: { kind: "valid", result: { summary: "Fixed it." } },
    });
    assert.equal(report.action, "completed");
    assert.deepEqual(report.refs, []);
    assert.doesNotMatch(report.body, /not reported as a completion/);
  });

  it("completes a run that wrote no result.json, and says so in the report", () => {
    // A runner with no result protocol keeps completing; the report no longer
    // hides that nothing was submitted.
    const report = buildReport({
      ...base,
      result: result({ stdoutTail: "patched 3 files" }),
      read: { kind: "absent" },
    });
    assert.equal(report.action, "completed");
    assert.match(report.body, /no result\.json was written/);
    assert.match(report.body, /patched 3 files/);
  });

  it("does not claim a missing result.json when the run wrote a valid one", () => {
    const report = buildReport({
      ...base,
      result: result(),
      read: { kind: "valid", result: { summary: "Fixed it." } },
    });
    assert.doesNotMatch(report.body, /no result\.json/);
  });

  it("blocks with needs:human when the executor asks a question, whatever its exit code", () => {
    for (const exitCode of [0, 1]) {
      const report = buildReport({
        ...base,
        attempt: 1,
        maxAttempts: 3,
        result: result({ exitCode }),
        read: {
          kind: "valid",
          result: { summary: "Half done.", needsHuman: "Delete the old table?" },
        },
      });
      assert.equal(report.action, "blocked");
      assert.equal(report.needsHuman, true);
      assert.match(report.body, /Question: Delete the old table\?/);
      assert.match(report.body, /Half done\./);
    }
  });

  it("waits for subtasks the run created instead of completing", () => {
    const report = buildReport({
      ...base,
      result: result(),
      read: { kind: "absent" },
      openChildren: 2,
    });
    assert.equal(report.action, "progressed");
    assert.match(report.body, /Waiting for 2 subtask\(s\)/);
  });
});

describe("structured results through a worker run", () => {
  it("gives the executor the result file and identity, and publishes what it wrote", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A }]);
    const seen: NodeJS.ProcessEnv[] = [];
    const worker = new Worker({
      backend,
      agentId: ME,
      machineId: "build-01",
      home,
      loadPolicy: async () => policy({ workdir: home }),
      executor: async (request) => {
        seen.push(request.env ?? {});
        const file = request.env?.["OGURI_RESULT_FILE"] as string;
        assert.ok(request.prompt.includes(file), "the prompt names the file");
        await mkdir(request.logDir, { recursive: true });
        await writeFile(
          file,
          JSON.stringify({
            summary: "Rotated the logs.",
            branch: "ops/rotate",
            artifacts: ["rotated.txt"],
          }),
        );
        return result({ stdoutTail: "noise" });
      },
    });
    await worker.pass();
    await worker.idle();

    const env = seen[0] ?? {};
    assert.equal(env["OGURI_HOME"], home);
    assert.equal(env["OGURI_AGENT"], ME);
    assert.equal(env["OGURI_TASK_ID"], ID_A);
    assert.equal(env["OGURI_TASK_ROOM"], "ops");
    assert.equal(env["OGURI_RESULT_FILE"], join(env["OGURI_RUN_DIR"] as string, "result.json"));

    const done = updates().at(-1);
    assert.equal(done?.action, "completed");
    assert.match(done?.body ?? "", /Rotated the logs\./);
    assert.doesNotMatch(done?.body ?? "", /noise/);
    assert.deepEqual(done?.refs, ["branch:ops/rotate", `artifact:build-01:${home}/rotated.txt`]);
  });

  it("publishes a noop as completed and relays the same wording", async () => {
    const { backend, updates, sent } = fakeBackend([{ id: ID_A, origin: ORIGIN }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ workdir: home }),
      executor: async (request) => {
        await mkdir(request.logDir, { recursive: true });
        await writeFile(
          request.env?.["OGURI_RESULT_FILE"] as string,
          JSON.stringify({ summary: "The settings are already correct.", outcome: "noop" }),
        );
        return result();
      },
    });
    await worker.pass();
    await worker.idle();
    assert.equal(updates().at(-1)?.action, "completed");
    assert.match(
      updates().at(-1)?.body ?? "",
      /No change needed: The settings are already correct\./,
    );
    assert.equal(
      sent().find((message) => message.relay === "result")?.body,
      "No change needed: The settings are already correct.",
    );
    assert.equal((await listRuns(home))[0]?.outcome, "completed");
  });

  it("records a rejected result.json on the run and does not report a completion", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ workdir: home }),
      executor: async (request) => {
        await mkdir(request.logDir, { recursive: true });
        await writeFile(request.env?.["OGURI_RESULT_FILE"] as string, '{"summary": 3}');
        return result({ stdoutTail: "the real output" });
      },
    });
    await worker.pass();
    await worker.idle();
    const done = updates().at(-1);
    assert.equal(done?.action, "blocked", "exit 0 with a rejected file is not a completion");
    assert.match(done?.body ?? "", /result\.json was rejected: "summary" must be/);
    assert.match(done?.body ?? "", /the real output/);
    assert.match(done?.body ?? "", /not reported as a completion/);
    assert.equal(done?.refs, undefined);
    assert.match((await listRuns(home))[0]?.note ?? "", /result\.json rejected/);
  });

  it("publishes a needsHuman question even when a PR field is null", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ workdir: home }),
      executor: async (request) => {
        await mkdir(request.logDir, { recursive: true });
        await writeFile(
          request.env?.["OGURI_RESULT_FILE"] as string,
          JSON.stringify({ summary: "Half done.", pr: null, needsHuman: "Drop the old table?" }),
        );
        return result();
      },
    });
    await worker.pass();
    await worker.idle();
    const done = updates().at(-1);
    assert.equal(done?.action, "blocked");
    assert.equal(done?.needsHuman, true);
    assert.match(done?.body ?? "", /Question: Drop the old table\?/);
  });

  it("completes a run with no result.json on a runner that does not require one, and records it", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ workdir: home }),
      executor: async () => result({ stdoutTail: "the real output" }),
    });
    await worker.pass();
    await worker.idle();
    const done = updates().at(-1);
    assert.equal(done?.action, "completed");
    assert.match(done?.body ?? "", /no result\.json was written/);
    assert.match(done?.body ?? "", /the real output/);
    const [run] = await listRuns(home);
    assert.equal(run?.outcome, "completed");
    assert.match(run?.note ?? "", /no result\.json written/);
  });

  it("never completes a run with no result.json on a runner that requires one", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({
          workdir: home,
          runners: { claude: { argv: ["claude", "-p"], worktree: false, requireResult: true } },
        }),
      executor: async () => result({ stdoutTail: "the real output" }),
    });
    await worker.pass();
    await worker.idle();
    const done = updates().at(-1);
    assert.equal(done?.action, "blocked", "exit 0 without the required file is not a completion");
    assert.match(done?.body ?? "", /requires a result\.json/);
    assert.match(done?.body ?? "", /not reported as a completion/);
    assert.match(done?.body ?? "", /the real output/);
    assert.doesNotMatch(done?.body ?? "", /^Done by worker/);
    const [run] = await listRuns(home);
    assert.equal(run?.outcome, "blocked");
    assert.match(run?.note ?? "", /result\.json rejected: .*requires/);
  });

  it("releases a required-result run that wrote nothing while attempts remain", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A, maxAttempts: 3 }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({
          workdir: home,
          runners: { claude: { argv: ["claude", "-p"], worktree: false, requireResult: true } },
        }),
      executor: async () => result(),
    });
    await worker.pass();
    await worker.idle();
    assert.equal(updates().at(-1)?.action, "released");
  });

  it("completes a required-result run that wrote a valid file", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A }]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({
          workdir: home,
          runners: { claude: { argv: ["claude", "-p"], worktree: false, requireResult: true } },
        }),
      executor: async (request) => {
        await mkdir(request.logDir, { recursive: true });
        await writeFile(
          request.env?.["OGURI_RESULT_FILE"] as string,
          JSON.stringify({ summary: "Done properly." }),
        );
        return result();
      },
    });
    await worker.pass();
    await worker.idle();
    const done = updates().at(-1);
    assert.equal(done?.action, "completed");
    assert.match(done?.body ?? "", /Done properly\./);
    assert.doesNotMatch(done?.body ?? "", /no result\.json/);
  });

  it("lets a real executor write the file through the environment", async () => {
    const logDir = join(home, "real");
    const file = join(logDir, "result.json");
    const run = await runExecutor({
      argv: [
        process.execPath,
        "-e",
        "require('fs').writeFileSync(process.env.OGURI_RESULT_FILE, JSON.stringify({summary:'from env'}))",
      ],
      cwd: home,
      prompt: "",
      timeoutMs: 10_000,
      logDir,
      env: { ...process.env, OGURI_RESULT_FILE: file },
    });
    assert.equal(run.exitCode, 0);
    assert.deepEqual(await readResult(file), { kind: "valid", result: { summary: "from env" } });
  });
});
