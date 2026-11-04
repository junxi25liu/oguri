import { realpathSync } from "node:fs";

/**
 * The script this process runs, with symlinks resolved.
 *
 * A global npm install puts a symlink on PATH (`…/bin/oguri`) that points at
 * the package's real file (`…/node_modules/oguri/dist/oguri.cjs`). Node keeps
 * the symlink in `process.argv[1]`, so a check on the file name sees `oguri`
 * and cannot tell that it is the bundle that can host the daemon and MCP.
 */
export function selfScript(argv1: string | undefined = process.argv[1]): string | undefined {
  if (argv1 === undefined) return undefined;
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}
