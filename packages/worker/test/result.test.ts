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
import { ME, fakeBackend, policy, result } from "./fake-backend.ts";

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
    refused({ summary: "x", artifacts: "a.txt" }, /"artifacts"/);
    refused({ summary: "x", artifacts: ["a\nb"] }, /single-line/);
    refused({ summary: "x", needsHuman: "" }, /"needsHuman"/);
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

  it("withholds a structured summary the secret scanner flags", () => {
    const report = buildReport({
      ...base,
      result: result(),
      read: { kind: "valid", result: { summary: `token ${TOKEN}` } },
    });
    assert.match(report.body, /Summary withheld/);
    assert.doesNotMatch(report.body, /ghp_/);
  });

  it("falls back to the output tail and says why when result.json is invalid", () => {
    const report = buildReport({
      ...base,
      result: result({ stdoutTail: "patched 3 files" }),
      read: { kind: "invalid", reason: "it is not valid JSON" },
    });
    assert.match(report.body, /result\.json was ignored: it is not valid JSON/);
    assert.match(report.body, /patched 3 files/);
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

  it("records an invalid result.json on the run and reports the output instead", async () => {
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
    assert.match(done?.body ?? "", /result\.json was ignored: "summary" must be/);
    assert.match(done?.body ?? "", /the real output/);
    assert.equal(done?.refs, undefined);
    assert.match((await listRuns(home))[0]?.note ?? "", /result\.json ignored/);
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
