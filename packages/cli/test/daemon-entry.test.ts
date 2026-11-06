import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SOCKET_PATH_MAX_BYTES, daemonEntryFor, socketPathProblem } from "../src/daemon-cmd.ts";

/**
 * Regression coverage for an install-breaking bug.
 *
 * A release install is ONE self-contained binary — `install.sh` never ships a
 * `ogurid`. The resolver nevertheless fell through to spawning `ogurid`, so
 * `oguri daemon start` could only ever fail with `spawn ogurid ENOENT`, and
 * `oguri daemon install` wrote a supervisor unit naming that same missing
 * binary, re-failing at every login. Presence stayed `away` forever as a
 * consequence, because it is the daemon that publishes the live transition.
 *
 * It survived because a workspace test run is always plain `node`, which takes
 * the first branch — the broken path is the one only real users reached.
 */
describe("daemon entry resolution", () => {
  it("runs the packaged binary as its own daemon host", () => {
    const entry = daemonEntryFor("/home/user/.local/bin/oguri", undefined, null);

    assert.deepEqual(entry, {
      command: "/home/user/.local/bin/oguri",
      args: ["daemon", "run"],
    });
    assert.notEqual(
      entry.command,
      "ogurid",
      "a release install ships no ogurid, so resolving one can only ENOENT",
    );
  });

  it("still prefers the workspace daemon script when one is next to the CLI", () => {
    const entry = daemonEntryFor(
      "/usr/local/bin/node",
      "/repo/packages/cli/dist/bin.js",
      "/repo/packages/daemon/dist/bin.js",
    );

    assert.deepEqual(entry, {
      command: "/usr/local/bin/node",
      args: ["/repo/packages/daemon/dist/bin.js"],
    });
  });

  it("falls back to PATH only for a plain-node run with no sibling", () => {
    assert.deepEqual(
      daemonEntryFor("/usr/local/bin/node", "/repo/packages/cli/dist/bin.js", null),
      {
        command: "ogurid",
        args: [],
      },
    );
    assert.deepEqual(daemonEntryFor("/usr/bin/node", undefined, null), {
      command: "ogurid",
      args: [],
    });
  });

  it("treats a node-named binary on Windows the same way", () => {
    assert.equal(
      daemonEntryFor("C:\\Program Files\\nodejs\\node.exe", undefined, null).command,
      "ogurid",
    );
    assert.equal(
      daemonEntryFor("C:\\Users\\someone\\oguri.exe", undefined, null).args[0],
      "daemon",
      "a packaged Windows binary must host the daemon itself too",
    );
  });
});

describe("daemon socket path length", () => {
  it("accepts a short path", () => {
    assert.equal(socketPathProblem("/home/user/.oguri/daemon.sock"), null);
  });

  it("names the real cause for a path the kernel cannot bind", () => {
    const long = `/home/user/${"a".repeat(SOCKET_PATH_MAX_BYTES)}/daemon.sock`;
    const message = socketPathProblem(long) ?? "";
    assert.match(message, /socket path is \d+ bytes/);
    assert.match(message, /shorter OGURI_HOME/);
  });

  it("counts bytes, not characters", () => {
    const wide = `/home/user/${"路".repeat(Math.ceil(SOCKET_PATH_MAX_BYTES / 3))}/daemon.sock`;
    assert.ok(wide.length < SOCKET_PATH_MAX_BYTES);
    assert.notEqual(socketPathProblem(wide), null);
  });
});
