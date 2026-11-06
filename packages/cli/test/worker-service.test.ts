import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Layout } from "@oguri/core";
import { DAEMON_SERVICE, renderUnit } from "@oguri/daemon";

import { INTAKE_SERVICE_ENV, intakeService } from "../src/commands/intake.ts";
import { SERVICE_ENV, cliEntryFor, workerService } from "../src/worker-service.ts";

describe("worker service", () => {
  const layout = new Layout("/home/b/.oguri/agents/bob-claude");
  const spec = workerService("bob-claude", layout);

  it("installs one unit per agent, never under the daemon's names", () => {
    assert.equal(spec.label, "dev.oguri.worker.bob-claude");
    assert.equal(spec.unit, "oguri-worker-bob-claude.service");
    assert.notEqual(spec.label, DAEMON_SERVICE.label);
    assert.notEqual(spec.unit, DAEMON_SERVICE.unit);
    assert.equal(workerService("bob-codex", layout).unit, "oguri-worker-bob-codex.service");
  });

  it("pins the agent's home, so a login service never guesses who it is", () => {
    assert.equal(spec.env?.["OGURI_HOME"], "/home/b/.oguri/agents/bob-claude");
    assert.equal(spec.env?.[SERVICE_ENV], "1");
    assert.ok((spec.env?.["PATH"] ?? "").length > 0, "runners are found on the user's PATH");
  });

  it("runs `oguri worker start` from whatever this CLI is", () => {
    assert.deepEqual(cliEntryFor("/usr/bin/node", "/repo/packages/cli/dist/bin.js"), {
      command: "/usr/bin/node",
      args: ["/repo/packages/cli/dist/bin.js"],
    });
    assert.deepEqual(cliEntryFor("/home/user/.local/bin/oguri", undefined), {
      command: "/home/user/.local/bin/oguri",
      args: [],
    });
    assert.deepEqual(cliEntryFor("/usr/bin/node", "/usr/lib/node_modules/oguri/x.js"), {
      command: "oguri",
      args: [],
    });
    const unit = renderUnit("systemd", "/home/user/.local/bin/oguri", ["worker", "start"], spec);
    assert.match(unit, /ExecStart=\/home\/user\/\.local\/bin\/oguri worker start/);
  });
});

describe("intake service", () => {
  const layout = new Layout("/home/b/.oguri/agents/team-intake");
  const spec = intakeService("team-intake", layout);

  it("installs its own unit, never under the worker's or the daemon's names", () => {
    assert.equal(spec.label, "dev.oguri.intake.team-intake");
    assert.equal(spec.unit, "oguri-intake-team-intake.service");
    assert.notEqual(spec.label, workerService("team-intake", layout).label);
    assert.notEqual(spec.unit, DAEMON_SERVICE.unit);
    assert.equal(spec.env?.["OGURI_HOME"], "/home/b/.oguri/agents/team-intake");
    assert.equal(spec.env?.[INTAKE_SERVICE_ENV], "1");
  });
});
