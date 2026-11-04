import { rollupParent } from "@oguri/worker";
import { assertRoomId, isUlid } from "@oguri/protocol";

import { type Ctx, bool, usage } from "../context.ts";
import { dim, green, json, out, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";

/**
 * `oguri task rollup <room> <parent-id>` — close a parent once its subtasks are done.
 *
 * The same step the worker takes every pass, for an agent that is not running
 * one: complete a parent this agent holds when every subtask has completed, or
 * post one note on it when a subtask is cancelled or waiting for a person.
 */
export async function cmdTaskRollup(ctx: Ctx): Promise<number> {
  const room = ctx.positionals[2];
  const parentId = ctx.positionals[3];
  if (room === undefined || parentId === undefined) {
    usage("task rollup needs <room> <parent-task-id>");
  }
  assertRoomId(room);
  if (!isUlid(parentId)) usage(`task rollup needs a task id (ULID), got '${parentId}'`);

  return await withBackend(ctx, async (be) => {
    const result = await rollupParent(be, ctx.config.agent.id, room, parentId);
    if (bool(ctx, "json")) {
      json(result);
      return 0;
    }
    if (result.action === "completed") {
      out(green(`✓ task ${parentId} completed`) + dim(` — ${result.reason}`));
    } else if (result.action === "noted") {
      out(yellow(`task ${parentId}: posted a note`) + dim(` — ${result.reason}`));
    } else {
      out(dim(`nothing to do: ${result.reason}`));
    }
    for (const child of result.children) {
      const refs = child.refs.length === 0 ? "" : dim(` ${child.refs.join(", ")}`);
      out(`  ${child.taskId}  ${child.state.padEnd(11)} ${child.title}${refs}`);
    }
    return 0;
  });
}
