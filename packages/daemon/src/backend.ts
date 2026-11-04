/**
 * How the CLI and MCP server reach oguri: over the daemon's socket when one is
 * running, or by opening a `Network` directly when not.
 *
 * The interface lives in `./backend/types.ts`, the two implementations beside
 * it, and the choice between them in `./backend/open.ts`. This module keeps the
 * import path every other package uses.
 */

export { openBackend } from "./backend/open.ts";
export type { OpenBackendOptions } from "./backend/open.ts";
export type { Backend, NetworkSummary } from "./backend/types.ts";
