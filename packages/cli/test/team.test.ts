import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * `oguri team` through the built binary. The point of the command is that the
 * roster, the capabilities and this machine's own runners are read together,
 * so the test asserts all three appear in one output and that the JSON mixes
 * network facts with local policy without inventing either.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

let tmp: string;
let home: string;

async function oguri(...args: string[]): Promise<Result> {
  const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1", OGURI_MACHINE_ID: "laptop" });
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function parseJson<T>(result: Result): T {
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-team-"));
  home = join(tmp, "home");
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri("init", "--repo", remote, "--network", "acme", "--agent", "liu-claude");
  await writeFile(
    join(home, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: false",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  runners:",
      `    claude: [${JSON.stringify(process.execPath)}, -e, "0"]`,
      `    brain: [${JSON.stringify(process.execPath)}, -e, "0"]`,
      "superagent:",
      "  big: { enabled: true, runner: brain }",
      "  small: { enabled: true, maxWorkers: 4 }",
      "",
    ].join("\n"),
  );
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri team", () => {
  it("prints the roster, a published capability, and this machine's runners together", async () => {
    const published = await oguri(
      "profile",
      "update",
      "--role",
      "backend",
      "--capability",
      "typescript",
      "--capability",
      "sqlite",
    );
    assert.equal(published.code, 0, published.stderr);

    const result = await oguri("team");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /machine:laptop/);
    assert.match(result.stdout, /liu-claude/);
    assert.match(result.stdout, /typescript, sqlite/);
    // The local half of the screen: the runners this machine may start, and
    // how many workers the small superagent may deploy at once.
    assert.match(result.stdout, /runners\s+claude, brain/);
    assert.match(result.stdout, /max workers\s+4/);
    assert.match(result.stdout, /big \+ small/);
  });

  it("reports the same facts as JSON, with no machine invented", async () => {
    const parsed = parseJson<{
      machines: {
        id: string | null;
        self: boolean;
        agents: { id: string; capabilities: string[] }[];
      }[];
      runners: string[];
      superagent: { big: boolean; small: boolean; maxWorkers: number; bigRunner?: string };
    }>(await oguri("team", "--json"));

    assert.equal(parsed.machines.length, 1);
    assert.equal(parsed.machines[0]?.id, "laptop");
    assert.equal(parsed.machines[0]?.self, true);
    assert.deepEqual(parsed.machines[0]?.agents[0]?.capabilities, ["typescript", "sqlite"]);
    assert.deepEqual(parsed.runners, ["claude", "brain"]);
    assert.equal(parsed.superagent.maxWorkers, 4);
    assert.equal(parsed.superagent.bigRunner, "brain");
  });

  it("keeps capabilities with the agent that declared them", async () => {
    // Two identities on one machine: the screen must not fold their
    // capabilities into one list, or "who can take this" becomes a guess about
    // which of the two just gained a skill.
    const added = parseJson<{ home: string }>(
      await oguri(
        "agent",
        "add",
        "liu-codex",
        "--repo",
        join(tmp, "transport.git"),
        "--tool",
        "codex",
        "--network",
        "acme",
        "--json",
      ),
    );
    assert.ok(added.home);

    const result = await oguri("team");
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.split("\n");
    const claude = lines.findIndex((line) => line.includes("liu-claude"));
    const codex = lines.findIndex((line) => line.includes("liu-codex"));
    assert.ok(claude >= 0 && codex > claude, result.stdout);
    assert.match(lines[claude + 1] ?? "", /typescript, sqlite/);
    assert.doesNotMatch(lines[codex + 1] ?? "", /typescript, sqlite/);
  });
});
