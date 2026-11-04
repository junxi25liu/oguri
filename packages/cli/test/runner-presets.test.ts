import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { parseLocalPolicy } from "@oguri/core";

import { PRESET_NAMES, RUNNER_PRESETS, presetsYaml } from "../src/commands/runner-presets.ts";

/**
 * `oguri runner presets` prints runner blocks a person pastes into
 * policy.yaml, so the load-bearing test is that the printed text parses.
 *
 * It must also not depend on a `model:` runner key: that field does not exist
 * in this version, and a preset that used it would be rejected at startup.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

let tmp: string;
let home: string;

async function oguri(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // `runner` is identity-neutral, but a developer's shell may still export an
  // OGURI_AGENT; clearing it keeps the test's home the one in play everywhere.
  const env: NodeJS.ProcessEnv = { ...process.env, OGURI_HOME: home, NO_COLOR: "1" };
  delete env["OGURI_AGENT"];
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-runner-presets-"));
  home = join(tmp, "home");
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the printed runner presets", () => {
  it("parse with this version's policy parser", () => {
    // The whole point: what this command prints must be accepted as policy
    // without the worker section being edited by hand first.
    const parsed = parseLocalPolicy(`${presetsYaml().join("\n")}\n`, "presets");
    const runners = parsed.worker?.runners ?? {};
    assert.deepEqual(Object.keys(runners), [...PRESET_NAMES]);
    for (const preset of RUNNER_PRESETS) {
      assert.deepEqual(runners[preset.name]?.argv, preset.runner.argv, preset.name);
    }
  });

  it("never uses a `model:` runner key, which this version does not parse", () => {
    const yaml = presetsYaml().join("\n");
    for (const line of yaml.split("\n")) {
      assert.doesNotMatch(line, /^\s+model:/, `a model: key would not parse: ${line}`);
    }
    // The model is named in argv instead, where the parser already accepts it.
    const dsk = RUNNER_PRESETS.find((preset) => preset.name === "dsk");
    assert.deepEqual(dsk?.runner.argv.slice(0, 4), [
      "claude",
      "-p",
      "--model",
      "deepseek-v4.1-flash",
    ]);
  });

  it("covers the runners the task named: live claude, claude-json, codex exec, cheap, brain", () => {
    assert.deepEqual(
      [...PRESET_NAMES],
      ["claude-live", "claude-json", "codex-exec", "dsk", "brain", "brain-lite"],
    );
    const byName = new Map(RUNNER_PRESETS.map((preset) => [preset.name, preset.runner]));
    assert.equal(byName.get("claude-live")?.session, "claude-stream");
    assert.equal(byName.get("claude-json")?.session, "claude-json");
    assert.equal(byName.get("codex-exec")?.session, "codex-jsonl");
    // A superagent's brain thinks without tools, and without oguri's own MCP tools.
    for (const name of ["brain", "brain-lite"]) {
      assert.ok(byName.get(name)?.argv.includes("--tools="), `${name} turns tools off`);
      assert.equal(byName.get(name)?.oguriTools, false, `${name} opts out of oguri's tools`);
    }
  });

  it("gives every session a resume form carrying {session} exactly once", () => {
    for (const preset of RUNNER_PRESETS) {
      if (preset.runner.session === undefined) continue;
      const resume = preset.runner.resume ?? [];
      const tokens = resume.join("\u0000").split("{session}").length - 1;
      assert.equal(tokens, 1, `${preset.name} resume carries {session} exactly once`);
    }
  });

  it("comments every block in both languages", () => {
    for (const preset of RUNNER_PRESETS) {
      assert.match(preset.titleZh, /[一-鿿]/, `${preset.name} has Chinese text`);
      assert.match(preset.titleEn, /[A-Za-z]/, `${preset.name} has English text`);
      const block = presetsYaml().join("\n");
      assert.ok(block.includes(preset.titleZh), `${preset.name}'s Chinese title is printed`);
      assert.ok(block.includes(preset.titleEn), `${preset.name}'s English title is printed`);
    }
  });
});

describe("oguri runner presets", () => {
  it("prints the pasteable block and writes nothing", async () => {
    const result = await oguri("runner", "presets");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^worker:$/m);
    assert.match(result.stdout, /^ {4}dsk:$/m);
    assert.match(result.stdout, /deepseek-v4\.1-flash/);
    assert.match(result.stdout, /--tools=/);
    // It prints; it never edits the machine's policy.
    await assert.rejects(() => stat(join(home, "policy.yaml")), { code: "ENOENT" });
  });

  it("prints the same thing for the bare `runner` word", async () => {
    const bare = await oguri("runner");
    const explicit = await oguri("runner", "presets");
    assert.equal(bare.code, 0, bare.stdout + bare.stderr);
    assert.equal(bare.stdout, explicit.stdout);
  });

  it("offers the presets as JSON, and that YAML still parses", async () => {
    const result = await oguri("runner", "presets", "--json");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const printed = JSON.parse(result.stdout) as {
      presets: { name: string; runner: { argv: string[] }; yaml: string }[];
      yaml: string;
    };
    assert.deepEqual(
      printed.presets.map((preset) => preset.name),
      [...PRESET_NAMES],
    );
    assert.doesNotThrow(() => parseLocalPolicy(`${printed.yaml}\n`, "presets"));
  });

  it("refuses an unknown subcommand", async () => {
    const result = await oguri("runner", "apply");
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /unknown runner subcommand 'apply'; use presets/);
  });
});
