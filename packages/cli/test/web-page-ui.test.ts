/**
 * The upgraded dashboard page: navigation, filters, detail, chat links,
 * connection recovery and the unified visual system (ADR 0028/0030).
 *
 * These tests execute the shipped page script in a small browser stub. They
 * assert what a person would see, not the implementation: hostile network
 * values stay text, unknown cost is not zero, config `on` is not online, a
 * poll cannot reset the filters, and both Big and machine chat entry points
 * are real links with the agreed target parameter.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext, type Context } from "node:vm";

import { POLL_MS, chatUrl, escapeHtml, renderPage, safeHref } from "../src/web/page.ts";
import { modelEvidence } from "../src/model-evidence.ts";

const HOSTILE = `<img src=x onerror="alert(1)">'"\`<script>alert(2)</script>`;
const HOSTILE_MACHINE = "machine " + HOSTILE;

function hrefRegex(target: string): RegExp {
  const href = chatUrl(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`href="${href}"|href="${href.replace(/'/g, "&#39;")}"`);
}

interface StubElement {
  id?: string;
  tagName?: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(name: string, fn: (event: unknown) => void): void;
  dispatch(name: string, event: unknown): void;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

function element(id: string, tagName = "DIV"): StubElement {
  const listeners = new Map<string, (event: unknown) => void>();
  const attributes = new Map<string, string>();
  return {
    id,
    tagName,
    textContent: "",
    innerHTML: "",
    hidden: false,
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    dispatch(name, event) {
      const fn = listeners.get(name);
      if (fn !== undefined) fn(event);
    },
    focus() {
      /* the stub records no caret state */
    },
    setSelectionRange() {
      /* the stub records no caret state */
    },
  };
}

function pageScript(): string {
  const page = renderPage("n0nce");
  return /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
}

function fixture() {
  const tasks = [
    {
      id: "T1",
      title: "Ledger " + HOSTILE,
      room: "ops",
      state: "in_progress",
      health: "active",
      assignee: "assignee " + HOSTILE,
      assigneeMachine: "local",
      target: "machine:local",
      updatedAt: "2026-11-04T11:59:00.000Z",
      source: "source " + HOSTILE,
      requester: "requester " + HOSTILE,
      definition: "A long definition " + HOSTILE,
      waitingOn: [],
      invalidEvents: [{ messageId: "M-bad", reason: HOSTILE, code: "invalid" }],
      currentMessageId: "M1",
      thread: "TH1",
      requires: ["typescript"],
      currentMessage: {
        id: "M1",
        from: "worker-a",
        ts: "2026-11-04T11:58:00.000Z",
        kind: "result",
        needs: "none",
        excerpt: "Published " + HOSTILE,
        link: "https://github.com/acme/app/pull/7",
      },
      threadMessages: [],
      needsYou: [
        {
          reason: "attention",
          taskId: "T1",
          title: "Ledger",
          room: "ops",
          source: "feishu",
          requester: "ou_alice",
          since: "2026-11-04T11:00:00.000Z",
          link: null,
          messageId: "M-Q",
          thread: "TH1",
        },
      ],
      runs: [
        {
          taskId: "T1",
          title: "Ledger",
          runner: "claude",
          startedAt: "2026-11-04T09:00:00.000Z",
          outcome: "running",
        },
      ],
      runner: "runner " + HOSTILE,
      machine: HOSTILE_MACHINE,
      machineConfidence: "reported",
      parent: "parent " + HOSTILE,
      roomError: null,
    },
    {
      id: "T2",
      title: "Cancel button",
      room: "ops",
      state: "blocked",
      health: "blocked",
      assignee: null,
      assigneeMachine: null,
      target: "machine:remote",
      updatedAt: "2026-11-04T11:30:00.000Z",
      source: null,
      requester: null,
      definition: "",
      waitingOn: [{ id: "T1", state: "in_progress" }],
      invalidEvents: [],
      currentMessageId: null,
      thread: "TH2",
      requires: [],
      currentMessage: null,
      threadMessages: [],
      needsYou: [],
      runs: [],
      runner: null,
      machine: "remote",
      machineConfidence: "reported",
      roomError: null,
    },
  ];
  return {
    generatedAt: "2026-11-04T12:00:00.000Z",
    mode: "daemon",
    agent: "worker-a",
    network: "acme",
    overview: {
      generatedAt: "2026-11-04T12:00:00.000Z",
      network: "acme",
      agent: "worker-a",
      mode: "daemon",
      remote: "https://github.com/acme/transport.git",
      sync: {
        degraded: false,
        lastSyncAt: "2026-11-04T11:59:30.000Z",
        ageSeconds: 30,
        confidence: "observed",
        reason: null,
      },
      daemon: { observed: true, sessionLive: true, loopRunning: true, cadence: "5s" },
      counts: {
        machines: 2,
        agents: 2,
        liveAgents: 1,
        running: 1,
        queued: 0,
        blocked: 1,
        completed: 0,
        needsYou: 1,
        needsHuman: 1,
        stateCounts: { in_progress: 1, blocked: 1 },
      },
      local: {
        runs: 1,
        running: 1,
        completed: 0,
        failed: 0,
        todayRuns: 1,
        todayCostUsd: null,
        costAvailable: false,
        costSource: null,
        maxPerHour: 12,
        maxConcurrent: 2,
        smallMaxWorkers: 3,
        runners: ["claude"],
        scope: "this machine only",
      },
      alerts: [{ level: "critical", text: "1 item(s) need a person " + HOSTILE, view: "overview" }],
    },
    machines: [{ id: "local", label: "local", self: true, live: 1, agents: [] }],
    machineViews: [
      {
        id: "local",
        label: "local",
        self: true,
        contested: false,
        humans: [],
        live: 1,
        agents: [
          {
            id: "worker-a",
            status: "live",
            confidence: "observed",
            lastSeen: "2026-11-04T11:59:00.000Z",
            sessions: 1,
            tool: "claude",
            role: "worker",
            focus: HOSTILE,
            workspace: "acme/payments",
            capabilities: ["typescript"],
            superagent: null,
          },
        ],
        tasks: [
          {
            id: "T1",
            title: "Ledger",
            state: "in_progress",
            machine: "local",
            runner: "claude",
            assignee: "worker-a",
          },
        ],
        localRuns: [],
        policy: {
          known: true,
          workerEnabled: true,
          bigEnabled: true,
          smallEnabled: false,
          runners: ["claude"],
          concurrency: 2,
          maxWorkers: 3,
          maxPerHour: 12,
          maxPerHourLabel: "runs/hour",
        },
      },
      {
        id: "remote",
        label: "remote",
        self: false,
        contested: false,
        humans: [],
        live: null,
        agents: [
          {
            id: "worker-b",
            status: "unknown",
            confidence: "unknown",
            capabilities: [],
            superagent: {
              role: "big",
              lastMessageAt: "2026-11-04T11:50:00.000Z",
              lastMessageId: "M-big",
              note: "message observed; process state unknown",
            },
          },
        ],
        tasks: [],
        localRuns: null,
        policy: null,
      },
    ],
    tasks,
    activity: [
      {
        id: "M1",
        room: "ops",
        from: "worker-a",
        ts: "2026-11-04T11:58:00.000Z",
        kind: "result",
        needs: "none",
        taskId: "T1",
        excerpt: HOSTILE,
      },
    ],
    needsYou: tasks[0]?.needsYou ?? [],
    needsHuman: [
      { id: "H1", room: "ops", from: "alice", ts: "2026-11-04T11:40:00.000Z", excerpt: HOSTILE },
    ],
    runs: [
      {
        taskId: "T1",
        room: "ops",
        title: "Ledger",
        runner: "claude",
        startedAt: "2026-11-04T09:00:00.000Z",
        outcome: "running",
        note: HOSTILE,
      },
    ],
    errors: ["tasks: room read failed " + HOSTILE],
    status: { remote: "https://github.com/acme/transport.git" },
    presence: [],
    agenda: null,
    rooms: [],
    readMethods: [],
  };
}

interface Harness {
  elements: Map<string, StubElement>;
  document: {
    getElementById(id: string): StubElement | undefined;
    documentElement: StubElement;
    addEventListener(name: string, fn: (event: unknown) => void): void;
    dispatch(name: string, event: unknown): void;
  };
  html(): string;
  view(name: string): void;
  nav(id: string): void;
  click(id: string): void;
  /** Click an element by a data attribute, as the shipped delegated handler sees it. */
  clickData(attribute: string, value: string): void;
  control(id: string, value: string): void;
  failures: number;
  polls: number;
  scrollTop: number;
  poll(): void;
  scrollTo(y: number): void;
}

async function boot(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const elements = new Map<string, StubElement>();
  const get = (id: string): StubElement => {
    let found = elements.get(id);
    if (found === undefined) {
      found = element(id, id === "app" ? "MAIN" : id.startsWith("view-") ? "SECTION" : "DIV");
      elements.set(id, found);
    }
    return found;
  };
  const documentElement = element("html", "HTML");
  const documentListeners = new Map<string, (event: unknown) => void>();
  const stored = new Map<string, string>();
  const data = { ...fixture(), ...overrides };
  let polls = 0;
  let failures = 0;
  let scrollTop = 42;
  let interval: (() => void) | null = null;
  const context: Context = {
    location: { hash: "", pathname: "/" },
    history: { replaceState: () => undefined },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    document: {
      getElementById: get,
      documentElement,
      addEventListener: (name: string, fn: (event: unknown) => void) =>
        documentListeners.set(name, fn),
    },
    window: {
      get scrollY() {
        return scrollTop;
      },
      scrollTo: (_y: number, y: number) => {
        scrollTop = y;
      },
    },
    setInterval: (fn: () => void) => {
      interval = fn;
      return 1;
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    fetch: async () => {
      polls += 1;
      if (overrides["fail"] === true && polls > 1) {
        failures += 1;
        throw new Error("connection refused " + HOSTILE);
      }
      return { ok: true, status: 200, json: async () => data };
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    matchMedia: () => ({ matches: false }),
    encodeURIComponent,
    decodeURIComponent,
    Date,
    Number,
    Math,
    Object,
    Array,
    String,
    JSON,
    console,
  };
  runInNewContext(pageScript(), context);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  return {
    elements,
    document: {
      getElementById: get,
      documentElement,
      addEventListener: (name: string, fn: (event: unknown) => void) =>
        documentListeners.set(name, fn),
      dispatch(name: string, event: unknown) {
        const fn = documentListeners.get(name);
        if (fn !== undefined) fn(event);
      },
    },
    html: () =>
      Object.values(Object.fromEntries(elements))
        .map((e) => e.innerHTML)
        .join(""),
    view: (name: string) => get("nav-" + name)?.dispatch("click", {}),
    nav: (id: string) => get(id)?.dispatch("click", {}),
    click: (id: string) => get(id)?.dispatch("click", {}),
    clickData(attribute: string, value: string) {
      documentListeners.get("click")?.({
        target: {
          closest: () => ({
            id: "",
            hasAttribute: (name: string) => name === attribute,
            getAttribute: (name: string) => (name === attribute ? value : null),
          }),
        },
      });
    },
    control: (id: string, value: string) => {
      const target = { id, value, focus: () => undefined, setSelectionRange: () => undefined };
      documentListeners.get("change")?.({ target });
    },
    get failures() {
      return failures;
    },
    get polls() {
      return polls;
    },
    get scrollTop() {
      return scrollTop;
    },
    poll() {
      interval?.();
    },
    scrollTo(y: number) {
      scrollTop = y;
    },
  };
}

describe("web execution centre page", () => {
  it("ships a self-contained, nonce-tagged visual system with no CDN", () => {
    const page = renderPage("n0nce");
    assert.match(page, /<style nonce="n0nce">/);
    assert.match(page, /<script nonce="n0nce">/);
    assert.ok(page.includes(escapeHtml.toString()), "the exact tested escaper runs");
    assert.ok(
      !/https?:\/\/(?!localhost|127\.0\.0\.1|github\.com)/.test(
        page.replace(/https?:\/\/(localhost|127\.0\.0\.1)/g, ""),
      ),
      "no CDN or external font",
    );
    assert.match(page, /id="nav-overview"/);
    assert.match(page, /id="nav-machines"/);
    assert.match(page, /id="nav-tasks"/);
    assert.match(page, /id="nav-runs"/);
    assert.match(page, /id="theme"/);
    assert.match(page, /aria-label="Dashboard sections"/);
    assert.match(page, /id="view-overview" data-is-view="true" aria-label="Overview"/);
    assert.match(page, /id="view-tasks" data-is-view="true" aria-label="Tasks" hidden/);
    assert.equal(POLL_MS, 5_000);
  });

  it("links to Big and per-machine chat using the /chat target parameter", () => {
    const page = renderPage("n");
    assert.match(page, /href="\/chat\?target=big"/);
    assert.equal(chatUrl("machine:machine-a"), "/chat?target=machine%3Amachine-a");
    assert.equal(safeHref("https://example.com/x"), "https://example.com/x");
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref("/chat?target=big"), "/chat?target=big");
  });

  it("escapes hostile data and shows clear unknown states on every view", async () => {
    const h = await boot();
    const overview = h.elements.get("view-overview")?.innerHTML ?? "";
    assert.ok(
      overview.includes("Needs you") &&
        overview.indexOf("Needs you") < overview.indexOf("Needs a human"),
    );
    assert.ok(overview.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(!overview.includes("<img") && !overview.includes("<script"));
    h.view("machines");
    const machines = h.elements.get("view-machines")?.innerHTML ?? "";
    assert.match(machines, /enabled in policy/);
    assert.match(machines, /not proof of a live process/);
    assert.match(machines, /message observed; process state unknown/);
    assert.match(machines, /remote config unknown/);
    assert.match(machines, /presence unknown/);
    assert.match(machines, hrefRegex("machine:local"));
    assert.match(machines, hrefRegex("machine:remote"));
    assert.ok(!machines.includes("<img") && !machines.includes("<script"));
    h.view("runs");
    const runs = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.match(runs, /Today&#39;s cost/);
    assert.match(runs, /unknown/);
    assert.ok(!runs.includes("$0.00"), "an unknown cost is never zero");
    assert.match(runs, /runs\/hour/);
    assert.match(runs, /not a dollar budget/);
    assert.match(runs, /this machine only/);
    assert.ok(!runs.includes("<img") && !runs.includes("<script"));
  });

  it("labels a partial cost as a known subtotal and counts what it omits", async () => {
    // The figure a person budgets by must say what it does not cover.
    const data = fixture();
    data.overview.local = {
      ...data.overview.local,
      todayRuns: 3,
      todayCostUsd: 1.25,
      todayUnpricedRuns: 2,
      costComplete: false,
      costAvailable: true,
      costSource: "local run logs",
    };
    const h = await boot({ overview: data.overview });
    h.view("runs");
    const runs = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.match(runs, /\$1\.25/);
    assert.match(runs, /known subtotal/);
    assert.match(runs, /2 run\(s\) unpriced/);
    assert.match(
      runs,
      /Worker runs only on this machine; excludes Big\/Small superagent brain sessions/,
    );
    assert.ok(!/\bcomplete total\b/.test(runs), "a partial figure is never called complete");
  });

  it("says complete only when every run today is inside the figure", async () => {
    const data = fixture();
    data.overview.local = {
      ...data.overview.local,
      todayRuns: 2,
      todayCostUsd: 3,
      todayUnpricedRuns: 0,
      costComplete: true,
      costAvailable: true,
      costSource: "local run logs",
    };
    const h = await boot({ overview: data.overview });
    h.view("runs");
    const runs = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.match(runs, /\$3\.00/);
    assert.match(runs, /complete total/);
    assert.ok(!runs.includes("known subtotal"));
  });

  it("shows a requested model as a request, never as what the service ran", async () => {
    // A cheap endpoint reports usage but names no model. Showing the argv's
    // model unmarked would state as observed something nobody observed.
    const data = fixture();
    data.runs = [
      {
        taskId: "T1",
        room: "ops",
        title: "Ledger",
        runner: "claude",
        startedAt: "2026-11-04T09:00:00.000Z",
        outcome: "completed",
        modelRequested: "example-cheap-model",
        effortRequested: "high",
      },
      {
        taskId: "T2",
        room: "ops",
        title: "Cancel button",
        runner: "claude",
        startedAt: "2026-11-04T09:30:00.000Z",
        outcome: "completed",
        modelRequested: "example-small-model",
        modelReported: "example-large-model",
      },
      {
        taskId: "T3",
        room: "ops",
        title: "No model recorded",
        runner: "codex",
        startedAt: "2026-11-04T10:00:00.000Z",
        outcome: "completed",
      },
    ];
    const h = await boot({ runs: data.runs });
    h.view("runs");
    const runs = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.match(runs, /example-cheap-model \(requested; service reported none\)/);
    assert.match(
      runs,
      /example-large-model \(legacy label; source unverified\)/,
      "legacy provenance is not invented",
    );
    assert.match(
      runs,
      /example-small-model \(requested\)/,
      "the request stays separate from the report",
    );
    assert.match(runs, /unknown/, "a run that recorded no model says so");
  });

  it("shows the same complete model evidence as the CLI, safely escaped", async () => {
    const evidence = {
      modelRequested: "request-A",
      modelInitialized: "init-B",
      modelReported: HOSTILE,
      modelSource: "assistant-message" as const,
      modelsUsage: ["u1", "u2"],
    };
    const data = fixture();
    const runs = [{ ...data.runs[0], ...evidence }];
    const h = await boot({ runs });
    h.view("runs");
    const html = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.ok(html.includes(escapeHtml(modelEvidence(evidence))));
    assert.ok(!html.includes("<img"));
  });

  it("labels effective concurrency and its raw worker value with source keys", async () => {
    const data = fixture();
    const h = await boot({
      overview: {
        ...data.overview,
        local: {
          ...data.overview.local,
          maxConcurrent: 20,
          concurrencySource: "superagent.small.maxWorkers",
          workerConcurrency: 1,
          smallMaxWorkers: 20,
          runners: ["new-runner"],
        },
      },
    });
    h.view("runs");
    const html = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.match(
      html,
      /Effective concurrency<\/dt><dd>20 run\(s\) at once, from superagent\.small\.maxWorkers/,
    );
    assert.match(html, /Raw worker concurrency<\/dt><dd>1 run\(s\), from worker\.concurrency/);
    assert.match(
      html,
      /Small starts<\/dt><dd>20 worker\(s\), from superagent\.small\.maxWorkers<\/dd>/,
    );
    assert.match(html, /Runners<\/dt><dd>new-runner<\/dd>/);
  });

  it("keeps filters, selection, scroll and detail state across polls and failures", async () => {
    const h = await boot();
    h.view("tasks");
    h.control("task-state", "blocked");
    h.control("task-machine", "remote");
    h.control("task-runner", "all");
    h.control("task-search", "Cancel");
    h.document.dispatch("click", {
      target: {
        closest: () => ({
          hasAttribute: (name: string) => name === "data-task",
          getAttribute: () => "T2",
          id: "",
        }),
      },
    });
    let html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /data-selected="true"/, "a task detail is selected");
    assert.match(html, /Cancel button/, "the selected task is visible");
    assert.ok(!html.includes("Ledger"), "state and machine filters are applied");
    assert.match(html, /value="Cancel"/);
    h.scrollTo(137);
    const connBefore = h.elements.get("conn")?.innerHTML ?? "";
    h.poll();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /value="Cancel"/, "a poll preserves the search filter");
    assert.match(html, /data-selected="true"/, "a poll preserves the selected task detail");
    assert.equal(h.scrollTop, 137, "a poll preserves scroll position");
    assert.match(html, /Cancel button/, "a poll preserves the task list");
    assert.ok(
      (h.elements.get("conn")?.innerHTML ?? "") !== "" && connBefore !== "",
      "connection state is visible",
    );
    h.document.dispatch("click", {
      target: {
        closest: () => ({
          id: "task-reset",
          hasAttribute: () => false,
          getAttribute: () => null,
        }),
      },
    });
    html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /Ledger/, "reset restores all tasks");
    assert.match(html, /value=""/, "reset clears the search input");
  });

  it("opens task detail with questions, errors, folding, copy and chat guidance", async () => {
    const h = await boot();
    h.view("tasks");
    h.document.dispatch("click", {
      target: {
        closest: () => ({
          hasAttribute: (name: string) => name === "data-task",
          getAttribute: () => "T1",
          id: "",
        }),
      },
    });
    const html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /Task detail/);
    assert.match(html, /Questions for you/);
    assert.match(html, /Invalid events/);
    assert.match(html, /Latest event \/ result/);
    assert.match(html, /<details>/, "long text is folded");
    assert.match(html, /data-copy=/, "code/output can be copied");
    assert.match(html, hrefRegex("machine:" + HOSTILE_MACHINE));
    assert.match(html, hrefRegex("big"));
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(!html.includes("<img") && !html.includes("<script"));
    assert.ok(
      (html.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/g) ?? []).length >= 12,
      "every task relation value is escaped, not just the title and definition",
    );
  });

  it("survives a connection failure without wiping rendered data", async () => {
    const h = await boot({ fail: true });
    h.view("tasks");
    h.poll();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    const html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /Connection lost/);
    assert.match(html, /retrying automatically/);
    assert.match(html, /Cancel button/, "the last good data remains readable");
    assert.equal(h.failures, 1);
    assert.ok(!html.includes("<img") && !html.includes("<script"));
  });

  it("cycles the local theme without any network request", async () => {
    const h = await boot();
    assert.equal(h.document.documentElement.getAttribute("data-theme"), "light");
    h.click("theme");
    assert.equal(h.document.documentElement.getAttribute("data-theme"), "light");
    h.click("theme");
    assert.equal(h.document.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(h.polls, 1, "only the initial data fetch happened");
  });

  it("shows every task state as a chip that filters the task list", async () => {
    const h = await boot();
    const overview = h.elements.get("view-overview")?.innerHTML ?? "";
    assert.match(overview, /aria-label="Tasks by state"/, "the hierarchy is a labelled group");
    assert.match(
      overview,
      /data-state-filter="in_progress"[^>]*aria-pressed="false"[^>]*>in progress <b>1<\/b>/,
    );
    assert.match(
      overview,
      /data-state-filter="blocked"[^>]*aria-pressed="false"[^>]*>blocked <b>1<\/b>/,
    );
    h.clickData("data-state-filter", "blocked");
    let tasks = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(tasks, /Cancel button/, "the chip opens the tasks view filtered to that state");
    assert.ok(!tasks.includes("Ledger"), "the other state's task is filtered out");
    assert.match(tasks, /state: blocked/, "the active filter is stated in the heading");
    // Pressing the same chip again clears it rather than leaving a dead filter.
    h.clickData("data-state-filter", "blocked");
    tasks = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(tasks, /Ledger/);
    assert.match(tasks, /Cancel button/);
  });

  it("reaches a machine's tasks as one list from the machines view", async () => {
    const h = await boot();
    h.view("machines");
    const machines = h.elements.get("view-machines")?.innerHTML ?? "";
    assert.match(machines, /data-machine-filter="remote"/);
    h.clickData("data-machine-filter", "remote");
    const tasks = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(tasks, /Cancel button/, "the machine's task is shown");
    assert.match(tasks, /value="remote" selected/, "the machine filter is set");
    assert.ok(!tasks.includes("Ledger"), "another machine's task is not shown");
  });

  it("says a limit is unknown instead of printing a bare dash", async () => {
    // Unreadable facts: a policy that was found but whose limits did not parse.
    const base = fixture();
    const overview = {
      ...base.overview,
      local: {
        ...base.overview.local,
        maxConcurrent: null,
        maxPerHour: null,
        smallMaxWorkers: null,
      },
    };
    const machineViews = (base.machineViews as { policy: Record<string, unknown> }[]).map(
      (machine, index) =>
        index === 0
          ? {
              ...machine,
              policy: { ...machine.policy, concurrency: null, maxWorkers: null, maxPerHour: null },
            }
          : machine,
    );
    const h = await boot({ overview, machineViews });
    h.view("runs");
    const runs = h.elements.get("view-runs")?.innerHTML ?? "";
    assert.equal(
      (runs.match(/<span class="muted">unknown<\/span>/g) ?? []).length,
      4,
      "effective, raw, hourly and Small limits are named unknown, not dashed out or zeroed",
    );
    assert.match(runs, /from worker\.concurrency/);
    assert.match(runs, /from superagent\.small\.maxWorkers/);
    h.view("machines");
    const machines = h.elements.get("view-machines")?.innerHTML ?? "";
    assert.match(machines, /concurrency <span class="muted">unknown<\/span>/, "the card agrees");
  });

  it("opens a task whose detail the current filters would hide", async () => {
    const h = await boot();
    h.view("tasks");
    h.control("task-state", "blocked");
    h.control("task-search", "Cancel");
    // A machines-view "Open" for T1, which the blocked+Cancel filter excludes.
    h.clickData("data-task", "T1");
    const html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /Task detail/);
    assert.match(html, /Ledger/, "the requested task is shown next to its detail");
    assert.match(html, /value=""/, "the search that hid it was cleared");
  });

  it("gives the task table a keyboard target and named columns", async () => {
    const h = await boot();
    h.view("tasks");
    const html = h.elements.get("view-tasks")?.innerHTML ?? "";
    assert.match(html, /<caption class="sr-only">/, "the table is described");
    assert.match(html, /<th scope="col">Task<\/th>/, "columns are headers for screen readers");
    assert.match(
      html,
      /<button type="button" class="title-btn" data-task="T1">/,
      "a real button opens the row",
    );
    assert.match(html, /<span class="sr-only">Machine: <\/span>/, "a bare value gets a label");
    assert.match(html, /<div class="table-scroll">/, "wide tables scroll on a phone");
  });

  it("announces changed counts without stealing focus", async () => {
    assert.match(
      renderPage("n"),
      /<p class="sr-only" id="status" role="status" aria-live="polite"><\/p>/,
      "the live region is in the first paint, before any data",
    );
    const h = await boot();
    const status = h.elements.get("status");
    assert.match(status?.textContent ?? "", /need you/, "the first load is announced");
    h.poll();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    assert.match(status?.textContent ?? "", /need you/, "an unchanged poll stays quiet, not blank");
  });

  it("keeps every palette entry at WCAG AA contrast", () => {
    const light = renderPage("n");
    // The palette is one declaration block per theme; read the pairs from it.
    function pairs(block: string): [string, string][] {
      const vars = new Map<string, string>();
      for (const match of block.matchAll(/--([a-z0-9-]+):(#[0-9a-f]{6})/g)) {
        vars.set(match[1] as string, match[2] as string);
      }
      const get = (name: string): string | null => vars.get(name) ?? null;
      const out: [string, string][] = [];
      const text = ["fg", "muted", "faint", "accent", "live", "warn", "bad", "unknown"];
      const backgrounds = [
        "surface",
        "surface-2",
        "accent-soft",
        "live-soft",
        "warn-soft",
        "bad-soft",
        "unknown-soft",
      ];
      for (const colour of text) {
        const value = get(colour);
        if (value === null) continue;
        for (const background of backgrounds) {
          const bg = get(background);
          if (bg !== null) out.push([value, bg]);
        }
      }
      return out;
    }
    const ratio = (a: string, b: string): number => {
      const luminance = (hex: string): number => {
        const channels = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
        const linear = channels.map((c) =>
          c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
        );
        return (
          0.2126 * (linear[0] as number) +
          0.7152 * (linear[1] as number) +
          0.0722 * (linear[2] as number)
        );
      };
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (high + 0.05) / (low + 0.05);
    };
    const blocks = [
      /:root\{([^}]*)\}/.exec(light)?.[1] ?? "",
      /:root\[data-theme="dark"\]\{([^}]*)\}/.exec(light)?.[1] ?? "",
    ];
    for (const block of blocks) {
      const entries = pairs(block);
      assert.ok(entries.length > 20, "the palette was found");
      for (const [colour, background] of entries) {
        const value = ratio(colour, background);
        assert.ok(value >= 4.5, `${colour} on ${background} is ${value.toFixed(2)}: below 4.5:1`);
      }
    }
  });

  it("covers dark mode before the script runs, without overriding an explicit choice", () => {
    const page = renderPage("n");
    assert.match(
      page,
      /@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{/,
      "system dark is honoured on first paint, and an explicit light choice still wins",
    );
    assert.match(page, /@media\(prefers-reduced-motion:reduce\)/);
    assert.match(page, /@media\(max-width:520px\)/);
  });
});
