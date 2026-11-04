import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

/**
 * install.sh for a private repository.
 *
 * A private repository's release assets answer 404 to plain curl, so the
 * download has to go through a signed-in `gh`. These tests run the real script
 * with a fake `gh` and a fake `curl` on PATH: the curl one fails, so a pass
 * proves the download came through `gh`, and the checksum is still enforced.
 */

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "..", "install.sh");

const BINARY = "#!/bin/sh\necho 1.0.0\n";
const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const archive = `oguri-v1.0.0-${target}.tar.gz`;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

let tmp: string;
let bin: string;
let assets: string;

async function install(args: string[], env: Record<string, string> = {}): Promise<Result> {
  const dir = await mkdtemp(join(tmp, "dest-"));
  try {
    const { stdout, stderr } = await exec("sh", [SCRIPT, "--install-dir", dir, ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, ...env },
    });
    return { code: 0, stdout: `${stdout}\n${dir}`, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function publish(sums: string): Promise<void> {
  await writeFile(join(assets, "SHA256SUMS"), sums);
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-install-"));
  bin = join(tmp, "bin");
  assets = join(tmp, "assets");
  await mkdir(bin);
  await mkdir(assets);

  // Signed in, one release, and downloads served from `assets`.
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "release view") echo v1.0.0; exit 0 ;;
  "release download")
    shift 2
    pattern=""; dir=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --pattern) pattern="$2"; shift 2 ;;
        --dir) dir="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    cp "${assets}/$pattern" "$dir/" ;;
  *) exit 1 ;;
esac
`,
  );
  // A private repository: curl is refused, as GitHub refuses it.
  await writeFile(join(bin, "curl"), "#!/bin/sh\necho 'curl was used' >&2\nexit 22\n");
  await chmod(join(bin, "gh"), 0o755);
  await chmod(join(bin, "curl"), 0o755);

  const staged = join(tmp, "staged");
  await mkdir(staged);
  await writeFile(join(staged, "oguri"), BINARY, { mode: 0o755 });
  await exec("tar", ["-czf", join(assets, archive), "-C", staged, "oguri"]);
  const hash = createHash("sha256")
    .update(await readFile(join(assets, archive)))
    .digest("hex");
  await publish(`${hash}  ${archive}\n`);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("install.sh", () => {
  it("installs a release through gh when curl cannot reach a private repository", async () => {
    const result = await install([]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Verifying checksum/);
    assert.match(result.stdout, /oguri installed to /);
    assert.doesNotMatch(result.stderr, /curl was used/);
  });

  it("still refuses a download whose checksum does not match", async () => {
    await publish(`${"0".repeat(64)}  ${archive}\n`);
    try {
      const result = await install([]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /CHECKSUM MISMATCH/);
    } finally {
      const hash = createHash("sha256")
        .update(await readFile(join(assets, archive)))
        .digest("hex");
      await publish(`${hash}  ${archive}\n`);
    }
  });

  it("installs a binary you already have, with nothing from GitHub", async () => {
    const file = join(tmp, "built-oguri");
    await writeFile(file, BINARY, { mode: 0o755 });
    // No gh and no curl at all: the file is all it needs.
    const result = await install(["--from-binary", file], { PATH: "/usr/bin:/bin" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /oguri installed to /);
  });

  it("says so when the binary cannot run here", async () => {
    const file = join(tmp, "wrong-platform");
    await writeFile(file, "#!/bin/sh\nexit 126\n", { mode: 0o755 });
    const result = await install(["--from-binary", file]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /did not run/);
    assert.match(result.stderr, /built per platform/);
  });

  it("names a missing binary", async () => {
    const result = await install(["--from-binary", join(tmp, "nope")]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no such file/);
  });

  it("refuses a source directory that is not an oguri checkout", async () => {
    const result = await install(["--source-dir", tmp]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not an oguri checkout/);
  });
});
