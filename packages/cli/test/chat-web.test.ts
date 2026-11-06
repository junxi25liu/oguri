/**
 * `/chat` over HTTP: a real write, its guarded reads, and the page's own
 * defenses. The dashboard's GET/HEAD + ReadOnlyBackend contract is checked too,
 * so registering chat cannot quietly widen the old surface.
 */

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { createMessage, ulid, type Message } from "@oguri/protocol";
import { FROM_SUPERAGENT_TAG, TO_BIG_TAG, TO_SMALL_TAG } from "@oguri/superagent";

import { CHAT_MAX_HTTP_BYTES, chatBackend, type ChatSources } from "../src/web/chat-api.ts";
import { escapeChatHtml, renderChatPage } from "../src/web/chat-page.ts";
import { dashboardHandler, planBind } from "../src/web/server.ts";
import type { ChatBackend } from "../src/chat/service.ts";
import { READ_METHODS, ReadOnlyBackend } from "../src/web/data.ts";

const SELF = "alice-cursor";
const BIG = "big-superagent";
const SMALL = "small-1";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const TOKEN = "a".repeat(24);
const HOSTILE = `<img src=x onerror="alert(1)">'"\`<script>alert(2)</script>`;

function message(
  input: Partial<Parameters<typeof createMessage>[0]> & { id: string; from: string; body: string },
): Message {
  return createMessage({
    room: "superagent",
    authorKind: "agent",
    kind: "msg",
    needs: "none",
    ts: new Date(NOW).toISOString(),
    ...input,
  });
}

interface FakeState {
  chat: ChatSources["chat"];
  calls: { method: string; params?: Record<string, unknown> }[];
  messages: Message[];
  reply(body?: string, from?: string): void;
}

function fakeChat(): FakeState {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const messages: Message[] = [];
  let sequence = 0;
  const chat: ChatBackend = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, ...(params === undefined ? {} : { params }) });
      switch (method) {
        case "status":
          return { subscriptions: ["superagent"] } as T;
        case "machines":
          return [
            {
              id: "machine-a",
              label: "Machine A",
              agents: [{ id: SMALL }],
              humans: [],
              contested: false,
              self: false,
              live: 1,
            },
          ] as T;
        case "presence":
          return [{ id: SMALL, status: "live" }] as T;
        case "sync":
        case "roomJoin":
        case "roomCreate":
          return undefined as T;
        case "read":
          return messages as T;
        case "send": {
          const input = (params?.["input"] ?? {}) as Record<string, unknown>;
          const parent = input["inReplyTo"] ?? input["thread"];
          sequence += 1;
          const created = message({
            id: ulid(NOW + sequence),
            from: SELF,
            body: `${String(input["body"] ?? "")}\n`,
            ...(typeof parent === "string" ? { inReplyTo: parent } : {}),
            ...(typeof parent === "string" ? { thread: parent } : {}),
            mentions: Array.isArray(input["mentions"]) ? (input["mentions"] as string[]) : [],
            tags: Array.isArray(input["tags"]) ? (input["tags"] as string[]) : [],
          });
          messages.push(created);
          return created as T;
        }
        default:
          throw new Error(`unexpected chat method ${method}`);
      }
    },
  };
  return {
    chat,
    calls,
    messages,
    reply(body = "real answer", from = BIG) {
      const last = messages.at(-1);
      if (last === undefined) return;
      sequence += 1;
      messages.push(
        message({
          id: ulid(NOW + sequence),
          from,
          body: `${body}\n`,
          inReplyTo: last.header.id,
          thread: last.header.thread,
          tags: [FROM_SUPERAGENT_TAG],
          mentions: [SELF],
        }),
      );
    },
  };
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function listen(
  state: FakeState,
  withToken = false,
): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const dashboardBackend = new ReadOnlyBackend({
    mode: "direct",
    async call<T>(method: string, _params?: Record<string, unknown>): Promise<T> {
      if (!(READ_METHODS as readonly string[]).includes(method)) {
        throw new Error(`dashboard cannot call '${method}'`);
      }
      switch (method) {
        case "status":
          return {
            networkId: "acme",
            remote: "https://example.com/t.git",
            agentId: SELF,
            subscriptions: [],
            pending: 0,
            pendingHuman: 0,
            lastSyncAt: null,
          } as T;
        case "agenda":
          return {
            counts: {
              assigned: 0,
              offered: 0,
              capable: 0,
              created: 0,
              unclaimed: 0,
              stale: 0,
              blocked: 0,
              stuck: 0,
            },
            entries: [],
          } as T;
        default:
          return [] as T;
      }
    },
  } as never);
  const server: Server = createServer(
    dashboardHandler({
      plan: planBind(withToken ? { token: TOKEN } : {}),
      backend: dashboardBackend,
      chat: { chat: state.chat, self: SELF, room: "superagent" },
      listRuns: async () => [],
      localPolicy: async () => ({
        workerEnabled: true,
        bigEnabled: true,
        smallEnabled: true,
        runners: ["claude"],
        concurrency: 3,
        maxWorkers: 5,
        maxPerHour: 20,
      }),
      localUsage: async () => ({ date: "2026-11-04", runs: 7, costUsd: 12.5 }),
      now: () => NOW,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

async function call(
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    host?: string;
    withHeaders?: boolean;
  } = {},
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      `${origin}${path}`,
      {
        method: options.method ?? "GET",
        headers: {
          host: options.host ?? "127.0.0.1",
          ...(options.withHeaders === false
            ? {}
            : { "x-oguri-chat": "1", "sec-fetch-site": "same-origin" }),
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function parse(response: Response): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("chat page", () => {
  it("escapes hostile text and renders only http(s) links", async () => {
    assert.equal(escapeChatHtml(HOSTILE).includes("<img"), false);
    assert.equal(escapeChatHtml(null), "");
    const page = renderChatPage("n0nce");
    assert.match(page, /<script nonce="n0nce">/);
    assert.ok(page.includes(escapeChatHtml.toString()), "the page runs this exact escaper");
    assert.ok(!/https?:\/\/(?!127|localhost)/.test(page), "no external assets");
    assert.ok(page.includes("Enter sends"));
    assert.ok(page.includes("Shift+Enter adds a line"));

    // Run the exact shipped script, just as web.test.ts does for the dashboard.
    // Inline <img>, onerror and <script> must all become text in the DOM.
    const hostile = {
      id: ulid(NOW),
      role: "them",
      from: HOSTILE,
      ts: new Date(NOW).toISOString(),
      body: `${HOSTILE}\n\n\`\`\`\n${HOSTILE}\n\`\`\`\nhttps://example.com/ JavaScript:alert(1)`,
      state: "ok",
    };
    const source = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
    type FakeElement = {
      textContent: string;
      innerHTML: string;
      className: string;
      value: string;
      disabled: boolean;
      scrollHeight: number;
      scrollTop: number;
      clientHeight: number;
      addEventListener: () => void;
      appendChild: () => void;
      focus: () => void;
    };
    const elements = new Map<string, FakeElement>();
    const element = (id: string): FakeElement => {
      const existing = elements.get(id);
      if (existing !== undefined) return existing;
      const created: FakeElement = {
        textContent: "",
        innerHTML: "",
        className: "",
        value: "",
        disabled: false,
        scrollHeight: 100,
        scrollTop: 0,
        clientHeight: 100,
        addEventListener: () => undefined,
        appendChild: () => undefined,
        focus: () => undefined,
      };
      elements.set(id, created);
      return created;
    };
    let doneResolve: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (doneResolve = resolve));
    runInNewContext(source, {
      location: {
        href: "http://127.0.0.1/chat?target=big",
        hash: "",
        pathname: "/chat",
        search: "?target=big",
      },
      history: { replaceState: () => undefined },
      sessionStorage: { getItem: () => null, setItem: () => undefined },
      document: {
        getElementById: element,
        createElement: (): FakeElement => ({
          textContent: "",
          innerHTML: "",
          className: "",
          value: "",
          disabled: false,
          scrollHeight: 100,
          scrollTop: 0,
          clientHeight: 100,
          addEventListener: () => undefined,
          appendChild: () => undefined,
          focus: () => undefined,
        }),
      },
      setInterval: () => 0,
      fetch: async (path: unknown) => {
        if (String(path).startsWith("/chat/api/history")) setTimeout(doneResolve, 0);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            targets: [{ value: "big", label: "Big" }],
            messages: [hostile],
            errors: [HOSTILE],
            presence: "live",
            waiting: false,
            timedOut: false,
          }),
        };
      },
      Date,
      Number,
      Math,
      Object,
      Array,
      String,
      JSON,
      URL,
      URLSearchParams,
      RegExp,
    });
    await done;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const html = element("app")?.innerHTML ?? "";
    assert.ok(html.includes("&lt;img"), "hostile text was rendered as text");
    assert.ok(!html.includes("<img"), "an img tag escaped the escaper");
    assert.ok(!html.includes("<script"), "a script tag escaped the escaper");
    assert.ok(!/onerror="/.test(html), "an attribute escaped the escaper");
    assert.ok(html.includes("<pre><code>"), "fenced code is escaped inside pre/code");
    assert.ok(!html.includes("javascript:"), "only http(s) links become anchors");
  });

  it("sends on Enter, lets Shift+Enter add a newline, and keeps late replies", () => {
    const page = renderChatPage("n");
    assert.match(page, /e\.key === "Enter" && !e\.shiftKey && !e\.isComposing/);
    assert.match(page, /setInterval\(refresh, POLL_MS\)/);
    assert.match(page, /JSON\.stringify\(bodyForSend\(body\)\)/);
    assert.ok(!page.includes('fetch("/chat/api/send", {\n      method: "POST"'));
  });
});

describe("chat HTTP routes", () => {
  it("shares a server with the execution centre without widening dashboard writes", async () => {
    const state = fakeChat();
    const server = await listen(state);
    try {
      const dashboard = await call(server.origin, "/api/dashboard");
      assert.equal(dashboard.status, 200);
      const overview = parse(dashboard)["overview"] as {
        local: {
          todayRuns: number;
          todayCostUsd: number;
          maxConcurrent: number;
          smallMaxWorkers: number;
          maxPerHour: number;
        };
      };
      assert.equal(overview.local.todayRuns, 7);
      assert.equal(overview.local.todayCostUsd, 12.5);
      assert.equal(overview.local.maxConcurrent, 3, "worker.concurrency, not the small cap");
      assert.equal(overview.local.smallMaxWorkers, 5, "the small superagent's own limit");
      assert.equal(overview.local.maxPerHour, 20);
      const page = await call(server.origin, "/chat?target=big", { withHeaders: false });
      assert.equal(page.status, 200);
      const write = await call(server.origin, "/api/dashboard", {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.origin },
        body: JSON.stringify({ body: "must not become a chat message" }),
      });
      assert.equal(write.status, 405);
      assert.equal(state.messages.length, 0);
      assert.equal(state.calls.length, 0, "dashboard reads never reach the chat backend");
    } finally {
      await server.close();
    }
  });

  it("serves the page without a token in the URL or HTML", async () => {
    const state = fakeChat();
    const server = await listen(state, true);
    try {
      const page = await call(server.origin, "/chat?target=big", { withHeaders: false });
      assert.equal(page.status, 200);
      assert.match(page.headers["content-security-policy"] as string, /script-src 'nonce-/);
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.headers["cache-control"], "no-store");
      assert.ok(!page.body.includes(TOKEN), "the bearer token is never in the HTML");
      assert.ok(
        !page.body.includes('sessionStorage.getItem("oguri-token") ='),
        "the page does not embed a token",
      );
      assert.equal(state.calls.length, 0, "the HTML page does not read the room");
    } finally {
      await server.close();
    }
  });

  it("sends one real request, keeps it in one thread, and shows a late reply once", async () => {
    const state = fakeChat();
    const server = await listen(state);
    const send = (body: string, thread?: string) =>
      call(
        server.origin,
        `/chat/api/send?target=big${thread === undefined ? "" : `&thread=${thread}`}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target: "big",
            body,
            ...(thread === undefined ? {} : { thread }),
          }),
        },
      );
    try {
      const first = parse(await send("第一句：你好"));
      assert.equal((first["messages"] as { body: string }[])[0]?.body, "第一句：你好");
      assert.equal(first["waiting"], true);
      assert.equal(typeof first["thread"], "string");
      const thread = first["thread"] as string;
      const root = state.messages[0];
      assert.deepEqual(root?.header.tags, [TO_BIG_TAG]);
      assert.equal(root?.header.inReplyTo, undefined);

      state.reply("回答：第一句");
      const late = parse(
        await call(server.origin, `/chat/api/history?target=big&thread=${thread}`),
      );
      assert.deepEqual(
        (late["messages"] as { body: string }[]).map((entry) => entry.body),
        ["第一句：你好", "回答：第一句"],
      );
      assert.equal(late["waiting"], false);

      const second = parse(await send("再说一句", thread));
      assert.equal(second["thread"], thread);
      const writes = state.calls.filter((entry) => entry.method === "send");
      assert.equal(writes.length, 2);
      const followUp = writes[1]?.params?.["input"] as Record<string, unknown>;
      assert.equal(followUp["inReplyTo"], thread);
      assert.equal(followUp["thread"], undefined);
      assert.deepEqual(state.messages[2]?.header.tags, [TO_BIG_TAG]);
      const history = parse(await call(server.origin, "/chat/api/history?target=big"));
      assert.deepEqual(
        (history["messages"] as { body: string }[]).map((entry) => entry.body),
        ["第一句：你好", "回答：第一句", "再说一句"],
      );
      assert.equal(
        (history["messages"] as { body: string }[]).filter((entry) => entry.body === "回答：第一句")
          .length,
        1,
      );
      assert.equal(state.calls.filter((entry) => entry.method === "send").length, 2);
    } finally {
      await server.close();
    }
  });

  it("shows same-identity Big replies over HTTP and clears the unanswered state", async () => {
    const state = fakeChat();
    const server = await listen(state);
    try {
      const sent = await call(server.origin, "/chat/api/send?target=big", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "big", body: "你在吗说句话" }),
      });
      assert.equal(sent.status, 200);
      const thread = parse(sent)["thread"] as string;
      state.reply("在。", SELF);
      // The real local Big intentionally omits a mention of its own identity.
      const reply = state.messages.at(-1);
      assert.ok(reply);
      reply.header.mentions = [];
      for (let poll = 0; poll < 2; poll += 1) {
        const response = await call(server.origin, `/chat/api/history?target=big&thread=${thread}`);
        assert.equal(response.status, 200);
        const history = parse(response);
        assert.deepEqual(
          (history["messages"] as { body: string; role: string }[]).map(({ body, role }) => ({
            body,
            role,
          })),
          [
            { body: "你在吗说句话", role: "you" },
            { body: "在。", role: "them" },
          ],
        );
        assert.equal(history["waiting"], false);
        assert.equal(history["timedOut"], false);
        assert.deepEqual(history["errors"], []);
      }
      assert.equal(state.calls.filter((entry) => entry.method === "send").length, 1);
    } finally {
      await server.close();
    }
  });

  it("separates Big and one machine's Small and keeps their deep links isolated", async () => {
    const state = fakeChat();
    const server = await listen(state);
    try {
      const small = parse(
        await call(server.origin, "/chat/api/send?target=machine%3Amachine-a", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: "machine:machine-a", body: "和这台机器说话" }),
        }),
      );
      assert.equal((small["target"] as { value: string })["value"], "machine:machine-a");
      assert.deepEqual(state.messages[0]?.header.tags, [TO_SMALL_TAG]);
      assert.deepEqual(state.messages[0]?.header.mentions, [SMALL]);
      state.reply("small answered", SMALL);
      const thread = small["thread"] as string;

      const big = parse(await call(server.origin, `/chat/api/history?target=big&thread=${thread}`));
      assert.deepEqual(big["messages"], []);
      const own = parse(
        await call(server.origin, `/chat/api/history?target=machine%3Amachine-a&thread=${thread}`),
      );
      assert.deepEqual(
        (own["messages"] as { body: string }[]).map((entry) => entry.body),
        ["和这台机器说话", "small answered"],
      );
      const targets = parse(await call(server.origin, "/chat/api/targets"));
      assert.ok(
        (targets["targets"] as { value: string }[]).some(
          (entry) => entry.value === "machine:machine-a",
        ),
      );
    } finally {
      await server.close();
    }
  });

  it("refuses cross-site, missing-header, bad-Host, and unauthenticated writes", async () => {
    const state = fakeChat();
    const server = await listen(state, true);
    const path = "/chat/api/send?target=big";
    const body = JSON.stringify({ target: "big", body: "must not be written" });
    const good = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    try {
      const cases: { name: string; options?: Parameters<typeof call>[2] }[] = [
        {
          name: "no custom header",
          options: { method: "POST", headers: good, withHeaders: false },
        },
        {
          name: "no bearer token",
          options: { method: "POST", headers: { "content-type": "application/json" } },
        },
        {
          name: "DNS rebinding Host",
          options: { method: "POST", headers: good, host: "attacker.example" },
        },
        {
          name: "cross-site Origin",
          options: {
            method: "POST",
            headers: { ...good, origin: "http://attacker.example" },
          },
        },
      ];
      for (const entry of cases) {
        const response = await call(server.origin, path, { ...entry.options, body });
        assert.ok([401, 403, 421].includes(response.status), `${entry.name}: ${response.status}`);
      }
      assert.equal(state.calls.filter((entry) => entry.method === "send").length, 0);

      const accepted = await call(server.origin, path, {
        method: "POST",
        headers: { ...good, origin: `${server.origin}` },
        body,
      });
      assert.equal(accepted.status, 200, accepted.body);
      assert.equal(state.calls.filter((entry) => entry.method === "send").length, 1);
    } finally {
      await server.close();
    }
  });

  it("refuses oversized, malformed, and mismatched requests before sending", async () => {
    const state = fakeChat();
    const server = await listen(state);
    const path = "/chat/api/send?target=big";
    const huge = JSON.stringify({ target: "big", body: "x".repeat(CHAT_MAX_HTTP_BYTES) });
    const cases: { body: string; status: number }[] = [
      { body: huge, status: 413 },
      { body: "{", status: 400 },
      { body: JSON.stringify({ target: "big", body: "x", unexpected: 1 }), status: 400 },
      { body: JSON.stringify({ target: "machine:machine-a", body: "x" }), status: 400 },
      { body: JSON.stringify({ target: "big", body: "" }), status: 400 },
    ];
    try {
      for (const entry of cases) {
        const response = await call(server.origin, path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: entry.body,
        });
        assert.equal(response.status, entry.status, response.body);
      }
      assert.equal(state.calls.filter((entry) => entry.method === "send").length, 0);
    } finally {
      await server.close();
    }
  });

  it("allows only the chat methods and leaves the dashboard read-only", async () => {
    const state = fakeChat();
    const guarded = chatBackend(state.chat);
    await assert.rejects(() => guarded.call("taskCreate"), /chat cannot call/);
    await assert.rejects(() => guarded.call("shell"), /chat cannot call/);
    await assert.rejects(() => guarded.call("agentProfile"), /chat cannot call/);
    assert.equal(state.calls.length, 0);

    const server = await listen(state);
    try {
      for (const method of ["POST", "DELETE"]) {
        const response = await call(server.origin, "/api/dashboard", {
          method,
          withHeaders: false,
        });
        assert.equal(response.status, 405, `${method}: ${response.status}`);
      }
      const head = await call(server.origin, "/api/status", {
        method: "HEAD",
        withHeaders: false,
      });
      assert.equal(head.status, 200);
      assert.equal(head.body, "");
      assert.equal(state.calls.filter((entry) => entry.method === "send").length, 0);
    } finally {
      await server.close();
    }
  });
});
