import {
  Layout,
  loadConfig,
  resolveNetwork,
  resolveProjectBinding,
  type AgentRuntimeEnvironment,
} from "@oguri/core";
import { stat } from "node:fs/promises";

import { DaemonClient } from "../client.ts";
import { DaemonBackend } from "./daemon.ts";
import { DirectBackend } from "./direct.ts";
import type { Backend } from "./types.ts";

export interface OpenBackendOptions {
  layout?: Layout;
  /** Directory whose local project binding is used when `network` is omitted. */
  projectPath?: string;
  network?: string;
  /** Skip the daemon even if one is running. Used by tests. */
  forceDirect?: boolean;
  /**
   * Connection surface recorded in the agent's advisory profile.
   *
   * Over the daemon this rides on declaring a session, so it is only recorded
   * when `session` is also set; in direct mode it is published on connect.
   */
  client?: string;
  /**
   * Declare this connection a long-lived agent session.
   *
   * Off by default, and that default is load-bearing. A session is a process
   * whose lifetime IS the session's — the MCP server, `oguri watch` — because
   * the daemon stamps this agent's card when the first one attaches, and that
   * stamp is a commit and a push on `main`. Declaring it for every one-shot
   * command wrote `live`, and then `away` when the second-long "session"
   * dropped, per invocation and per network (ADR 0022).
   */
  session?: boolean;
  /**
   * A watcher with no agent behind it (`oguri web`). Over the daemon, its
   * reads do not count as an agent at the keyboard. See `IpcRequest.passive`.
   */
  passive?: boolean;
}

export async function openBackend(options: OpenBackendOptions = {}): Promise<Backend> {
  const layout = options.layout ?? new Layout();
  const config = await loadConfig(layout.configPath);
  const project =
    config === null || options.network !== undefined
      ? null
      : resolveProjectBinding(config, options.projectPath ?? process.cwd());
  const selectedNetwork = options.network ?? project?.network;
  const environment: AgentRuntimeEnvironment | undefined =
    options.client === undefined
      ? undefined
      : {
          client: options.client,
          platform: process.platform,
          architecture: process.arch,
        };

  if (options.forceDirect !== true) {
    const client = await DaemonClient.tryConnect(layout.socketPath);
    if (client !== null) {
      // A daemon serving a different identity than this home resolves to is not
      // a faster path to the same answer — it is a different agent's view of
      // the network. Refusing to use it beats silently reading someone else's
      // inbox; falling through opens this home directly, which is correct.
      const serves = await client.identity().catch(() => null);
      const wanted = config?.agent.id;
      if (serves === null || wanted === undefined || serves === wanted) {
        if (options.passive === true) client.passive = true;
        if (options.session === true) {
          await client.openSession(environment, selectedNetwork).catch(() => undefined);
        }
        return new DaemonBackend(client, selectedNetwork);
      }
      client.close();
    }
  }

  if (config === null) {
    throw new Error(
      `oguri is not configured (${layout.configPath} not found). Run: oguri init --repo <url>`,
    );
  }
  const mtimeMs = await stat(layout.configPath)
    .then((info) => info.mtimeMs)
    .catch(() => 0);
  const backend = new DirectBackend(layout, config, resolveNetwork(config, selectedNetwork), {
    ...(selectedNetwork === undefined ? {} : { requested: selectedNetwork }),
    mtimeMs,
  });
  // Description is useful but advisory. A temporary push failure must not make
  // an editor lose the entire MCP connection; record-outbox sync retries it.
  if (environment !== undefined) {
    await backend.publishConnectionProfile(environment).catch(() => undefined);
  }
  return backend;
}
