import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { after, before, describe, it } from "node:test";

import type { Backend } from "@oguri/daemon";
import { Layout } from "@oguri/core";

import { escapeHtml, renderPage } from "../src/web/page.ts";
import { READ_METHODS, ReadOnlyBackend, redactRemote, taskView } from "../src/web/data.ts";
import { needsYou, sortNeedsYou } from "../src/web/needs-you.ts";
import {
  bearerMatches,
  dashboardUrl,
  isLoopbackHost,
  planBind,
  startDashboard,
} from "../src/web/server.ts";
import { testEnv } from "./env.ts";

/**
 * `oguri web` (ADR 0028): read-only, loopback by default, token beyond it,
 * and every value from another machine escaped before it reaches the DOM.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const HOSTILE = `<img src=x onerror="alert(1)">'"\`<script>alert(2)</script>`;

describe("dashboard HTML escaping", () => {
  it("escapes every character that can open a tag, an attribute, or a template", () => {
    assert.equal(
      escapeHtml(`<a href="x" title='y'>&\`</a>`),
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;",
    );
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(42), "42");
  });

  it("ships the tested escaper inside the page", () => {
    const page = renderPage("n0nce");
    assert.ok(page.includes(escapeHtml.toString()), "the page runs this exact function");
    assert.ok(!/https?:\/\/(?!localhost)/.test(page.replace(/http:\/\/localhost/g, "")), "no CDN");
    assert.match(page, /<script nonce="n0nce">/);
  });

  it("renders hostile message text as text", async () => {
    // Run the page's own script against a dashboard full of markup, the way a
    // browser would, and inspect what it puts in the DOM.
    const page = renderPage("n");
    const source = /<script nonce="n">([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
    const elements = new Map<string, { textContent: string; innerHTML: string }>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "" });
      return elements.get(id);
    };
    const data = {
      mode: "direct",
      agent: HOSTILE,
      network: "acme",
      errors: [HOSTILE],
      needsYou: [
        {
          reason: HOSTILE,
          taskId: HOSTILE,
          title: HOSTILE,
          room: HOSTILE,
          source: HOSTILE,
          requester: HOSTILE,
          since: "",
          link: `https://example.com/"><img src=x onerror="alert(1)">`,
        },
        { reason: "attention", title: "t", room: "r", link: `javascript:alert(1)` },
      ],
      needsHuman: [{ id: "1", room: HOSTILE, from: HOSTILE, ts: "", excerpt: HOSTILE }],
      machines: [
        {
          id: HOSTILE,
          label: HOSTILE,
          self: true,
          live: 1,
          agents: [{ id: HOSTILE, status: HOSTILE, focus: HOSTILE }],
        },
      ],
      rooms: [
        {
          room: HOSTILE,
          error: HOSTILE,
          tasks: [
            {
              id: HOSTILE,
              title: HOSTILE,
              state: "blocked",
              health: HOSTILE,
              assignee: HOSTILE,
              target: HOSTILE,
              dependsOn: [HOSTILE],
              parent: HOSTILE,
              children: [HOSTILE],
              source: HOSTILE,
              requester: HOSTILE,
              updatedAt: "",
            },
          ],
          messages: [
            {
              from: HOSTILE,
              kind: HOSTILE,
              needs: HOSTILE,
              external: HOSTILE,
              relay: HOSTILE,
              ts: "",
              excerpt: HOSTILE,
            },
          ],
        },
      ],
      runs: [
        {
          outcome: HOSTILE,
          taskId: HOSTILE,
          title: HOSTILE,
          room: HOSTILE,
          runner: HOSTILE,
          exitCode: HOSTILE,
          startedAt: "",
        },
      ],
    };
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    runInNewContext(source, {
      location: { hash: "", pathname: "/" },
      history: { replaceState: () => undefined },
      sessionStorage: { getItem: () => null, setItem: () => undefined },
      document: { getElementById: element },
      setInterval: () => 0,
      fetch: async () => {
        setTimeout(resolveDone, 0);
        return { ok: true, status: 200, json: async () => data };
      },
      Date,
      Number,
      Math,
      Object,
      Array,
      String,
      JSON,
    });
    await done;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const html = element("app")?.innerHTML ?? "";
    assert.ok(html.length > 0, `nothing rendered; state: ${element("state")?.textContent ?? ""}`);
    assert.ok(!html.includes("<img"), "an img tag escaped the escaper");
    assert.ok(!html.includes("<script"), "a script tag escaped the escaper");
    assert.ok(!/onerror="/.test(html), "an attribute escaped the escaper");
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(html.indexOf("Needs you") < html.indexOf("Needs a human"), "Needs you comes first");
    assert.ok(!html.includes("javascript:"), "only http(s) links become anchors");
    assert.equal((html.match(/<a href=/g) ?? []).length, 1, "the https link is an anchor");
  });
});

describe("dashboard exposure", () => {
  it("binds to loopback with no token by default", () => {
    const plan = planBind({});
    assert.equal(plan.host, "127.0.0.1");
    assert.equal(plan.port, 7380);
    assert.equal(plan.token, null);
  });

  it("recognises loopback hosts and only those", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      assert.ok(isLoopbackHost(host), host);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.1.nip.io"]) {
      assert.ok(!isLoopbackHost(host), host);
    }
  });

  it("refuses a non-loopback host without --allow-remote", () => {
    assert.throws(() => planBind({ host: "0.0.0.0" }), /--allow-remote/);
  });

  it("generates a token for a remote bind, or uses the one given", () => {
    const generated = planBind({ host: "0.0.0.0", allowRemote: true });
    assert.equal(generated.generated, true);
    assert.ok((generated.token ?? "").length >= 32);
    const given = planBind({ host: "0.0.0.0", allowRemote: true, token: "x".repeat(20) });
    assert.equal(given.token, "x".repeat(20));
    assert.throws(() => planBind({ host: "0.0.0.0", allowRemote: true, token: "short" }), /16/);
  });

  it("compares bearer tokens exactly", () => {
    const token = "abcdefghijklmnopqrstuvwx";
    assert.ok(bearerMatches(`Bearer ${token}`, token));
    assert.ok(bearerMatches(`bearer ${token}`, token));
    assert.ok(!bearerMatches(`Bearer ${token}x`, token));
    assert.ok(!bearerMatches(token, token));
    assert.ok(!bearerMatches(undefined, token));
  });

  it("puts the token in the URL fragment, which browsers never send", () => {
    const url = dashboardUrl({ host: "0.0.0.0", port: 7380, token: "t/k", generated: true }, 7380);
    assert.equal(url, "http://0.0.0.0:7380/#token=t%2Fk");
  });

  it("strips credentials from a remote URL", () => {
    assert.equal(
      redactRemote("https://user:ghp_x@github.com/acme/t.git"),
      "https://github.com/acme/t.git",
    );
    assert.equal(redactRemote("git@github.com:acme/t.git"), "git@github.com:acme/t.git");
  });
});

/** A backend that records calls and fails on anything outside the read list. */
function fakeBackend(calls: string[]): Backend {
  return {
    mode: "direct",
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push(method);
      const room = params["room"];
      const answers: Record<string, unknown> = {
        status: {
          networkId: "acme",
          remote: "https://bob:secret@example.com/t.git",
          agentId: "alice-cursor",
          subscriptions: ["architecture"],
          pending: 1,
          pendingHuman: 1,
          lastSyncAt: null,
        },
        machines: [{ id: "alice-mbp", label: "alice-mbp", self: true, live: 1, agents: [] }],
        presence: [],
        agenda: { entries: [], counts: {}, inFlightThreads: [] },
        inbox: [
          {
            id: "01H",
            room: "architecture",
            from: "bob-codex",
            ts: "2026-11-02T00:00:00Z",
            body: HOSTILE,
            needs: "human",
          },
        ],
        tasks:
          room === "architecture"
            ? [
                {
                  task: {
                    id: "T1",
                    title: "Ledger",
                    state: "blocked",
                    creator: "alice-cursor",
                    assignee: "bob-codex",
                    dependsOn: ["T0"],
                  },
                  currentMessageId: "M1",
                  thread: "M0",
                  updatedAt: "2026-11-02T00:00:00Z",
                  stale: false,
                  health: "blocked",
                },
                {
                  task: {
                    id: "T2",
                    title: "Cancel button",
                    state: "in_progress",
                    creator: "intake-bot",
                    origin: {
                      source: "feishu",
                      conversation: "oc_team",
                      message: "om_1",
                      requester: "ou_alice",
                    },
                  },
                  currentMessageId: "M2",
                  thread: "M2",
                  updatedAt: "2026-11-02T00:00:00Z",
                  stale: false,
                  health: "active",
                },
              ]
            : [],
        read:
          room === "architecture"
            ? [
                { header: { id: "M1", thread: "M0", needs: "human", refs: [] }, body: "" },
                {
                  header: {
                    id: "M3",
                    thread: "M2",
                    from: "bob-codex",
                    ts: "2026-11-02T01:00:00Z",
                    kind: "question",
                    needs: "none",
                    relay: "attention",
                    refs: [],
                  },
                  body: "Which browsers?",
                },
              ]
            : [],
      };
      if (!(method in answers)) throw new Error(`unexpected call ${method}`);
      return answers[method] as T;
    },
    async networks() {
      return [];
    },
    async close() {
      /* nothing to release */
    },
  };
}

describe("dashboard endpoints", () => {
  const calls: string[] = [];
  let base: string;
  let close: () => Promise<void>;
  const token = "a-token-of-at-least-16-chars";

  before(async () => {
    const started = await startDashboard({
      backend: new ReadOnlyBackend(fakeBackend(calls)),
      listRuns: async () => [
        {
          taskId: "T1",
          room: "architecture",
          title: "Ledger",
          runner: "claude",
          startedAt: "2026-11-02T00:00:00Z",
          outcome: "running",
        },
      ],
      plan: { host: "127.0.0.1", port: 0, token, generated: false },
    });
    base = `http://127.0.0.1:${String(started.port)}`;
    close = async () => {
      started.server.closeAllConnections();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    };
  });
  after(async () => {
    await close();
  });

  const auth = { authorization: `Bearer ${token}` };

  it("serves the page without the token, with a strict CSP", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.ok(!(await res.text()).includes("alice-cursor"), "the page itself carries no data");
  });

  it("requires the bearer token on every API endpoint", async () => {
    for (const path of ["/api/dashboard", "/api/status", "/api/runs", "/api/rooms"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, path);
      const wrong = await fetch(`${base}${path}`, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401, path);
    }
  });

  it("returns JSON for every endpoint", async () => {
    for (const path of [
      "/api/dashboard",
      "/api/status",
      "/api/machines",
      "/api/agenda",
      "/api/needs-human",
      "/api/needs-you",
      "/api/rooms",
      "/api/room?room=architecture",
      "/api/runs",
    ]) {
      const res = await fetch(`${base}${path}`, { headers: auth });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, path);
      await res.json();
    }
  });

  it("aggregates needs-human, tasks with relationships, and runs", async () => {
    const res = await fetch(`${base}/api/dashboard`, { headers: auth });
    const body = (await res.json()) as {
      needsHuman: { excerpt: string }[];
      rooms: { room: string; tasks: { id: string; dependsOn: string[]; state: string }[] }[];
      runs: { taskId: string }[];
      status: { remote: string };
      errors: string[];
    };
    assert.deepEqual(body.errors, []);
    assert.equal(body.needsHuman.length, 1);
    assert.equal(body.needsHuman[0]?.excerpt, HOSTILE, "JSON carries raw text; the page escapes");
    assert.equal(body.rooms[0]?.tasks[0]?.state, "blocked");
    assert.deepEqual(body.rooms[0]?.tasks[0]?.dependsOn, ["T0"]);
    assert.equal(body.runs[0]?.taskId, "T1");
    assert.ok(!body.status.remote.includes("secret"), "remote credentials are stripped");
  });

  it("lists what needs a person first, with the chat it came from", async () => {
    const res = await fetch(`${base}/api/dashboard`, { headers: auth });
    const body = (await res.json()) as {
      needsYou: {
        reason: string;
        taskId: string;
        source: string | null;
        requester: string | null;
      }[];
      rooms: { tasks: { id: string; source: string | null }[] }[];
    };
    assert.deepEqual(
      body.needsYou.map((item) => [item.reason, item.taskId]),
      [
        ["needs-human", "T1"],
        ["attention", "T2"],
      ],
    );
    assert.equal(body.needsYou[1]?.source, "feishu");
    assert.equal(body.needsYou[1]?.requester, "ou_alice");
    assert.equal(body.rooms[0]?.tasks.find((t) => t.id === "T2")?.source, "feishu");

    const alone = await fetch(`${base}/api/needs-you`, { headers: auth });
    assert.deepEqual(await alone.json(), body.needsYou);
  });

  it("refuses every method that could change state", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/status`, { method, headers: auth });
      assert.equal(res.status, 405, method);
    }
  });

  it("only ever calls read methods on the backend", () => {
    assert.ok(calls.length > 0);
    for (const method of calls) {
      assert.ok((READ_METHODS as readonly string[]).includes(method), method);
    }
  });

  it("refuses a Host header that does not name loopback (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/api/status`,
        { headers: { ...auth, host: "evil.example:7380" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421);
  });

  it("rejects a write method even if a route tried one", async () => {
    const guarded = new ReadOnlyBackend(fakeBackend([]));
    await assert.rejects(
      guarded.call("send" as unknown as "status"),
      /the dashboard does not call 'send'/,
    );
  });
});

// ------------------------------------------------------------ needs you

type Status = Parameters<typeof needsYou>[1][number];
type Msg = Parameters<typeof needsYou>[2][number];

function status(id: string, state: string, extra: Record<string, unknown> = {}): Status {
  return {
    task: { id, title: `Task ${id}`, state, creator: "intake-bot", ...extra },
    currentMessageId: `${id}-now`,
    thread: `${id}-root`,
    updatedAt: "2026-11-02T00:00:00.000Z",
  } as unknown as Status;
}

let seq = 0;
function message(thread: string, header: Record<string, unknown> = {}): Msg {
  seq += 1;
  return {
    header: {
      id: `01K${String(seq).padStart(23, "0")}`,
      thread,
      ts: `2026-11-02T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
      needs: "none",
      refs: [],
      ...header,
    },
    body: "",
  } as unknown as Msg;
}

describe("needs you", () => {
  const now = Date.parse("2026-11-03T00:00:00.000Z");
  const origin = { source: "feishu", conversation: "oc_t", message: "om", requester: "ou_a" };

  it("lists a task blocked on a person, and not one blocked on an agent", () => {
    const human = status("H", "blocked", { origin });
    const agent = status("A", "blocked");
    const items = needsYou(
      "ops",
      [human, agent],
      [
        message("H-root", { id: "H-now", needs: "human" }),
        message("A-root", { id: "A-now", needs: "agent" }),
      ],
      now,
    );
    assert.deepEqual(
      items.map((item) => [item.reason, item.taskId, item.source, item.requester]),
      [["needs-human", "H", "feishu", "ou_a"]],
    );
  });

  it("lists an attention relay until a person in the chat writes after it", () => {
    const task = status("Q", "in_progress", { origin });
    const asked = message("Q-root", { relay: "attention" });
    assert.deepEqual(
      needsYou("ops", [task], [asked], now).map((item) => [item.reason, item.messageId]),
      [["attention", asked.header.id]],
    );
    const bot = message("Q-root", { external: { source: "feishu", human: false } });
    assert.equal(needsYou("ops", [task], [asked, bot], now).length, 1, "a bot is not an answer");
    const reply = message("Q-root", { external: { source: "feishu", human: true } });
    assert.deepEqual(needsYou("ops", [task], [asked, bot, reply], now), []);
    const again = message("Q-root", { relay: "attention" });
    assert.equal(needsYou("ops", [task], [asked, reply, again], now).length, 1, "a new question");
  });

  it("lists a recently completed task whose result names a pull request", () => {
    const done = status("P", "completed");
    const completion = message("P-root", {
      id: "P-now",
      refs: ["branch:oguri/P", "https://github.com/acme/app/pull/7"],
    });
    const items = needsYou("ops", [done], [completion], now);
    assert.deepEqual(
      items.map((item) => [item.reason, item.link]),
      [["pull-request", "https://github.com/acme/app/pull/7"]],
    );
    const later = Date.parse("2026-11-20T00:00:00.000Z");
    assert.deepEqual(needsYou("ops", [done], [completion], later), [], "not after the window");
    const noPr = message("P-root", { id: "P-now", refs: ["branch:oguri/P"] });
    assert.deepEqual(needsYou("ops", [done], [noPr], now), []);
  });

  it("puts decisions first, then questions, then pull requests, oldest first", () => {
    const item = (reason: "needs-human" | "attention" | "pull-request", since: string) => ({
      reason,
      since,
      taskId: since,
      title: "",
      room: "r",
      source: null,
      requester: null,
      link: null,
      messageId: "",
    });
    const sorted = sortNeedsYou([
      item("pull-request", "1"),
      item("attention", "2"),
      item("needs-human", "4"),
      item("needs-human", "3"),
    ]);
    assert.deepEqual(
      sorted.map((i) => i.taskId),
      ["3", "4", "2", "1"],
    );
  });
});

describe("task view", () => {
  it("tolerates tasks without relationship fields", () => {
    const view = taskView({
      task: { id: "T", title: "t", state: "open", creator: "a", staleAfterSeconds: 60 },
      updatedAt: "",
      stale: false,
      health: "active",
    } as unknown as Parameters<typeof taskView>[0]);
    assert.deepEqual(view.dependsOn, []);
    assert.deepEqual(view.children, []);
    assert.equal(view.parent, null);
  });
});

// ------------------------------------------------------------------ end to end

describe("oguri web, through the built binary", () => {
  let tmp: string;
  let home: string;
  let remotePath: string;
  let child: ChildProcess | null = null;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oguri-web-"));
    const remote = join(tmp, "transport.git");
    remotePath = remote;
    home = join(tmp, "alice");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
    await exec(
      process.execPath,
      [CLI, "init", "--repo", remote, "--network", "acme", "--agent", "alice-cursor"],
      { env },
    );
    await exec(process.execPath, [CLI, "room", "create", "architecture"], { env });
  });

  after(async () => {
    child?.kill("SIGTERM");
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("refuses a non-loopback host without --allow-remote", async () => {
    const result = await exec(process.execPath, [CLI, "web", "--host", "0.0.0.0", "--direct"], {
      env: testEnv({ OGURI_HOME: home, NO_COLOR: "1" }),
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({
        code: error.code ?? 1,
        stderr: error.stderr ?? "",
      }),
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--allow-remote/);
  });

  it("serves the dashboard on loopback and stops on SIGTERM", async () => {
    child = spawn(process.execPath, [CLI, "web", "--port", "0", "--direct"], {
      env: testEnv({ OGURI_HOME: home, NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise<string>((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error(`no URL printed: ${seen}`)), 20_000);
      child?.stdout?.setEncoding("utf8");
      child?.stdout?.on("data", (chunk: string) => {
        seen += chunk;
        const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(seen);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child?.once("exit", (code) => reject(new Error(`exited ${String(code)}: ${seen}`)));
    });

    const res = await fetch(`${url}api/dashboard`);
    assert.equal(res.status, 200, "loopback with no token needs none");
    const body = (await res.json()) as {
      agent: string;
      rooms: { room: string }[];
      errors: string[];
    };
    assert.equal(body.agent, "alice-cursor");
    assert.deepEqual(
      body.rooms.map((r) => r.room),
      ["architecture"],
    );
    assert.deepEqual(body.errors, []);

    const exited = new Promise<number | null>((resolve) => child?.once("exit", resolve));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    child = null;
  });

  /**
   * The dashboard's machine-local half, through the real command.
   *
   * `cmdWeb` is the only place that reads `policy.yaml` and the run logs, and
   * it used to leave both callbacks out, so the page always said "unknown"
   * even where a real answer existed. Driving the binary is the only way to
   * catch that wiring missing again: a handler-level fixture supplies the
   * callbacks itself and cannot see the gap.
   */
  it("passes this machine's policy and run history into the dashboard", async () => {
    const home = join(tmp, "bob");
    const layout = new Layout(home);
    const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
    await exec(
      process.execPath,
      [CLI, "init", "--repo", remotePath, "--network", "acme", "--agent", "bob-cursor"],
      { env },
    );
    // A policy with two limits that differ, so the page cannot confuse them.
    await writeFile(
      join(home, "policy.yaml"),
      [
        "v: 1",
        "worker:",
        "  enabled: true",
        "  concurrency: 4",
        "  maxPerHour: 18",
        "  runners:",
        '    cheap: ["my-cheap-model", "-p"]',
        "superagent:",
        "  small:",
        "    maxWorkers: 6",
        "",
      ].join("\n"),
      "utf8",
    );
    // One run today whose log carries a price, and one local day of usage.
    // It is finished on purpose: `todayUsage` leaves a run still in flight out
    // of the subtotal, because a running run's cumulative figure is not final.
    const runDir = join(layout.root, "runs", "01MTASK");
    await mkdir(runDir, { recursive: true });
    const startedAt = new Date().toISOString();
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        taskId: "01MTASK",
        runId: "01MRUN",
        room: "architecture",
        title: "wired run",
        runner: "cheap",
        startedAt,
        outcome: "completed",
      }),
      "utf8",
    );
    await writeFile(
      join(runDir, "stdout.log"),
      `${JSON.stringify({ type: "result", total_cost_usd: 1.25 })}\n`,
      "utf8",
    );

    const server = spawn(process.execPath, [CLI, "web", "--port", "0", "--direct"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let seen = "";
        const timer = setTimeout(() => reject(new Error(`no URL printed: ${seen}`)), 20_000);
        server.stdout?.setEncoding("utf8");
        server.stdout?.on("data", (chunk: string) => {
          seen += chunk;
          const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(seen);
          if (match !== null) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
        server.once("exit", (code) => reject(new Error(`exited ${String(code)}: ${seen}`)));
      });
      const res = await fetch(`${url}api/dashboard`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        overview: {
          local: {
            todayRuns: number;
            todayCostUsd: number | null;
            todayUnpricedRuns: number | null;
            costComplete: boolean;
            costAvailable: boolean;
            maxConcurrent: number | null;
            smallMaxWorkers: number | null;
            maxPerHour: number | null;
            runners: string[];
          };
        };
        machineViews: {
          self: boolean;
          policy: { known: boolean; concurrency: number | null; maxWorkers: number | null } | null;
        }[];
      };
      const local = body.overview.local;
      assert.equal(local.maxConcurrent, 4, "worker.concurrency reaches the page");
      assert.equal(local.maxPerHour, 18);
      assert.equal(local.smallMaxWorkers, 6, "small.maxWorkers is a separate figure");
      assert.deepEqual(local.runners, ["cheap"], "runners come from policy.yaml");
      assert.equal(local.todayRuns, 1, "the local run is counted");
      assert.equal(local.todayCostUsd, 1.25, "the price in the run log is reported");
      assert.equal(local.todayUnpricedRuns, 0, "the one run today is inside the figure");
      assert.equal(local.costComplete, true);
      assert.equal(local.costAvailable, true);
      const own = body.machineViews.find((machine) => machine.self);
      assert.equal(own?.policy?.known, true, "this machine's policy is known");
      assert.equal(own?.policy?.concurrency, 4);
    } finally {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    }
  });

  it("never reports an unknown local cost as zero", async () => {
    const home = join(tmp, "carol");
    const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
    await exec(
      process.execPath,
      [CLI, "init", "--repo", remotePath, "--network", "acme", "--agent", "carol-cursor"],
      { env },
    );
    const server = spawn(process.execPath, [CLI, "web", "--port", "0", "--direct"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let seen = "";
        const timer = setTimeout(() => reject(new Error(`no URL printed: ${seen}`)), 20_000);
        server.stdout?.setEncoding("utf8");
        server.stdout?.on("data", (chunk: string) => {
          seen += chunk;
          const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(seen);
          if (match !== null) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
        server.once("exit", (code) => reject(new Error(`exited ${String(code)}: ${seen}`)));
      });
      const body = (await (await fetch(`${url}api/dashboard`)).json()) as {
        overview: {
          local: { todayCostUsd: number | null; costAvailable: boolean; costComplete: boolean };
        };
      };
      assert.equal(body.overview.local.todayCostUsd, null);
      assert.equal(body.overview.local.costAvailable, false);
      assert.equal(
        body.overview.local.costComplete,
        false,
        "an unknown figure is never a complete one",
      );
    } finally {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    }
  });
});
