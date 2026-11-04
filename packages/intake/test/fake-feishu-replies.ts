/**
 * A fake Feishu on loopback: the token endpoint and the reply endpoint, with
 * every hit recorded as Feishu would receive it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const REPLY_PATH = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/;

export interface Hit {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
  /** The message replied under, for a reply hit. */
  replyTo?: string;
}

export interface Answer {
  status: number;
  body: unknown;
}

export class FakeFeishu {
  hits: Hit[] = [];
  /** How the reply endpoint answers; success with a fresh message id by default. */
  replyAnswer: (hit: Hit, n: number) => Answer = (_hit, n) => ({
    status: 200,
    body: { code: 0, msg: "success", data: { message_id: `om_reply_${String(n)}` } },
  });
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (raw += chunk));
      req.on("end", () => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const match = REPLY_PATH.exec(path);
        const hit: Hit = {
          path,
          authorization: req.headers["authorization"],
          body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
          ...(match === null ? {} : { replyTo: decodeURIComponent(match[1] as string) }),
        };
        this.hits.push(hit);
        let answer: Answer;
        if (path === TOKEN_PATH) {
          answer = {
            status: 200,
            body: { code: 0, msg: "ok", tenant_access_token: "t-fake", expire: 7200 },
          };
        } else if (match !== null) {
          answer = this.replyAnswer(hit, this.replies.length);
        } else {
          answer = { status: 404, body: { code: 404 } };
        }
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  get replies(): Hit[] {
    return this.hits.filter((hit) => hit.replyTo !== undefined);
  }

  /** The text of each reply, in arrival order. */
  get texts(): string[] {
    return this.replies.map(
      (hit) => (JSON.parse(hit.body["content"] as string) as { text: string }).text,
    );
  }

  reset(): void {
    this.hits = [];
    this.replyAnswer = (_hit, n) => ({
      status: 200,
      body: { code: 0, msg: "success", data: { message_id: `om_reply_${String(n)}` } },
    });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
