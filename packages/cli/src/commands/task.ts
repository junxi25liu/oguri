import { type Agenda, type TaskDetail, type TaskStatus } from "@oguri/core";
import {
  type Message,
  MAX_TASK_ATTEMPTS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_REQUIRES,
  TASK_UPDATE_ACTIONS,
  assertAgentId,
  assertMachineId,
  assertRoomId,
  isMachineToken,
  isTaskCapability,
  isTaskUpdateAction,
  isUlid,
  machineMention,
} from "@oguri/protocol";
import {
  ago,
  bold,
  cyan,
  dim,
  green,
  json,
  messageToJson,
  out,
  red,
  renderAgenda,
  renderTaskDetail,
  yellow,
} from "../output.ts";

import { buildTaskTree, graphSummary, renderTaskTree } from "../task-graph.ts";
import { cmdApprove } from "./approvals.ts";
import { cmdTaskRollup } from "./rollup.ts";
import { type Ctx, bool, list, num, str, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

/**
 * The `--target` / `--machine` pair, resolved to one task target.
 *
 * `--machine <id>` is sugar for `--target machine:<id>` and exists because the
 * token form is the sort of thing a person gets subtly wrong once and then
 * cannot see. Both at once is refused rather than ranked: silently preferring
 * one would hand the work to a party the caller did not name.
 */
function taskTarget(ctx: Ctx): string | undefined {
  const target = str(ctx, "target");
  const machines = list(ctx, "machine");
  if (target !== undefined && machines.length > 0) {
    usage("use either --target or --machine, not both");
  }
  if (machines.length > 1) usage("a task can be offered to one machine, not several");
  const machine = machines[0];
  if (machine !== undefined) return machineMention(assertMachineId(machine));
  if (target === undefined) return undefined;
  if (isMachineToken(target)) return target;
  return assertAgentId(target);
}

/**
 * The graph flags of `task create`, checked before anything is sent.
 *
 * They are fixed at creation, so a mistake here cannot be corrected later by a
 * refinement — refusing early is the only cheap moment to catch it.
 */
export function taskGraphInput(ctx: Ctx): {
  dependsOn?: string[];
  parent?: string;
  requires?: string[];
  maxAttempts?: number;
} {
  const dependsOn = list(ctx, "depends-on");
  for (const id of dependsOn) {
    if (!isUlid(id)) usage(`--depends-on must be a task id (ULID), got '${id}'`);
  }
  if (new Set(dependsOn).size !== dependsOn.length) usage("--depends-on names a task twice");
  if (dependsOn.length > MAX_TASK_DEPENDENCIES) {
    usage(`a task can depend on at most ${String(MAX_TASK_DEPENDENCIES)} tasks`);
  }
  const parent = str(ctx, "parent");
  if (parent !== undefined && !isUlid(parent)) {
    usage(`--parent must be a task id (ULID), got '${parent}'`);
  }
  const requires = list(ctx, "requires");
  for (const name of requires) {
    if (!isTaskCapability(name)) {
      usage(`--requires '${name}' is not a capability name ([a-z][a-z0-9-]{0,31})`);
    }
  }
  if (new Set(requires).size !== requires.length) usage("--requires names a capability twice");
  if (requires.length > MAX_TASK_REQUIRES) {
    usage(`a task can require at most ${String(MAX_TASK_REQUIRES)} capabilities`);
  }
  const maxAttempts = num(ctx, "max-attempts");
  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_TASK_ATTEMPTS)
  ) {
    usage(`--max-attempts must be an integer from 1 to ${String(MAX_TASK_ATTEMPTS)}`);
  }
  return {
    ...(dependsOn.length === 0 ? {} : { dependsOn }),
    ...(parent === undefined ? {} : { parent }),
    ...(requires.length === 0 ? {} : { requires }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

/** `--add-depends-on` / `--remove-depends-on` of `task update relinked`, checked before anything is sent. */
function relinkInput(ctx: Ctx): { addDependsOn?: string[]; removeDependsOn?: string[] } {
  const read = (key: string): string[] => {
    const ids = list(ctx, key);
    for (const id of ids) {
      if (!isUlid(id)) usage(`--${key} must be a task id (ULID), got '${id}'`);
    }
    if (new Set(ids).size !== ids.length) usage(`--${key} names a task twice`);
    return ids;
  };
  const addDependsOn = read("add-depends-on");
  const removeDependsOn = read("remove-depends-on");
  const both = addDependsOn.filter((id) => removeDependsOn.includes(id));
  if (both.length > 0) usage(`${both.join(", ")} is both added and removed`);
  return {
    ...(addDependsOn.length === 0 ? {} : { addDependsOn }),
    ...(removeDependsOn.length === 0 ? {} : { removeDependsOn }),
  };
}

export async function cmdTask(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === undefined) {
    usage("task needs a subcommand: create, claim, update, show, list, tree, or agenda");
  }

  // Agenda spans every subscribed room, so it takes no room argument — it is
  // the answer to "what am I on the hook for", not "what is in this room".
  if (sub === "agenda") return await cmdAgenda(ctx);
  if (sub === "approve") return await cmdApprove(ctx, "task");
  if (sub === "rollup") return await cmdTaskRollup(ctx);

  const room = ctx.positionals[2];
  if (room === undefined) {
    usage("task needs a room: task create|claim|update|show|list|tree <room>");
  }
  assertRoomId(room);

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "create": {
        const definition = ctx.positionals.slice(3).join(" ");
        const title = str(ctx, "title");
        if (title === undefined || definition === "") {
          usage("task create needs <room> <text> --title <one-line title>");
        }
        const target = taskTarget(ctx);
        const staleAfterSeconds = num(ctx, "stale-after");
        if (
          staleAfterSeconds !== undefined &&
          (!Number.isInteger(staleAfterSeconds) ||
            staleAfterSeconds < 60 ||
            staleAfterSeconds > 365 * 24 * 60 * 60)
        ) {
          usage("--stale-after must be an integer from 60 to 31536000 seconds");
        }
        const priority = str(ctx, "priority");
        const graph = taskGraphInput(ctx);
        const message = await be.call<Message>("taskCreate", {
          room,
          input: {
            title,
            definition,
            ...(target === undefined ? {} : { target }),
            ...(staleAfterSeconds === undefined ? {} : { staleAfterSeconds }),
            ...(priority === undefined ? {} : { priority }),
            ...graph,
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else {
          out(green("✓ task created") + dim(` ${message.header.task?.id ?? ""}`));
          out(
            dim(
              `  ${
                target === undefined
                  ? "free to claim"
                  : isMachineToken(target)
                    ? `offered to every agent on ${target.slice("machine:".length)}`
                    : `target → ${target}`
              }`,
            ),
          );
          const created = message.header.task;
          if (created?.dependsOn !== undefined) {
            out(dim(`  claimable once ${created.dependsOn.join(", ")} complete`));
          }
          if (created?.parent !== undefined) out(dim(`  subtask of ${created.parent}`));
          if (created?.requires !== undefined) {
            out(dim(`  only agents declaring ${created.requires.join(", ")} may claim`));
          }
          if (created?.maxAttempts !== undefined) {
            out(dim(`  at most ${String(created.maxAttempts)} claim(s)`));
          }
        }
        return 0;
      }
      case "claim": {
        const taskId = ctx.positionals[3];
        const body = ctx.positionals.slice(4).join(" ");
        if (taskId === undefined || body === "") {
          usage("task claim needs <room> <task-id> <what you are taking and first step>");
        }
        const message = await be.call<Message>("taskClaim", { room, taskId, body });
        if (bool(ctx, "json")) json(messageToJson(message));
        else out(green(`✓ task ${taskId} claimed`) + dim(` ${message.header.id}`));
        return 0;
      }
      case "update": {
        const taskId = ctx.positionals[3];
        const action = ctx.positionals[4];
        const body = ctx.positionals.slice(5).join(" ");
        if (taskId === undefined || !isTaskUpdateAction(action) || body === "") {
          usage(
            `task update needs <room> <task-id> <action> <text>; action is one of: ${TASK_UPDATE_ACTIONS.join(", ")}`,
          );
        }
        const target = taskTarget(ctx);
        if (target !== undefined && bool(ctx, "free"))
          usage("use either --target or --free, not both");
        const needs = str(ctx, "needs");
        if (needs !== undefined && needs !== "human") {
          usage("task update accepts only --needs human; omit it for agent-owned progress");
        }
        const title = str(ctx, "title");
        const refs = list(ctx, "ref");
        const relink = relinkInput(ctx);
        if (action !== "relinked" && Object.keys(relink).length > 0) {
          usage("--add-depends-on and --remove-depends-on apply only to the 'relinked' action");
        }
        const message = await be.call<Message>("taskUpdate", {
          room,
          taskId,
          input: {
            action,
            body,
            ...(refs.length === 0 ? {} : { refs }),
            ...(title === undefined ? {} : { title }),
            ...relink,
            ...(target === undefined && !bool(ctx, "free")
              ? {}
              : { target: bool(ctx, "free") ? null : target }),
            ...(needs === "human" ? { needsHuman: true } : {}),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else {
          const state = message.header.task?.state ?? "unknown";
          out(green(`✓ task ${taskId} → ${state}`) + dim(` ${message.header.id}`));
          if (action === "relinked") {
            const now = message.header.task?.dependsOn ?? [];
            out(
              dim(
                now.length === 0 ? "  no dependencies now" : `  now depends on ${now.join(", ")}`,
              ),
            );
          }
          if (message.header.needs === "human") {
            out(dim("  parked for a critical human decision; attribution remains cooperative."));
          }
        }
        return 0;
      }
      case "show": {
        const taskId = ctx.positionals[3];
        if (taskId === undefined) usage("task show needs <room> <task-id>");
        const detail = await be.call<TaskDetail>("taskShow", { room, taskId });
        if (bool(ctx, "json")) json(detail);
        else renderTaskDetail(detail);
        return 0;
      }
      case "list": {
        const tasks = await be.call<TaskStatus[]>("tasks", { room });
        if (bool(ctx, "json")) {
          json(tasks);
          return 0;
        }
        if (tasks.length === 0) {
          out(dim(`no tasks in ${room}`));
          return 0;
        }
        for (const status of tasks) {
          const task = status.task;
          const state = status.stale ? `stale/${task.state}` : task.state;
          const owner = task.assignee ?? task.target ?? "any agent";
          const conflicts =
            status.invalidEvents.length === 0
              ? ""
              : red(` · ${String(status.invalidEvents.length)} invalid event(s)`);
          out(
            `${bold(task.id)}  ${status.stale ? yellow(state.padEnd(20)) : cyan(state.padEnd(20))} ${task.title} → ${owner} · ${ago(status.updatedAt)}${graphSummary(status)}${conflicts}`,
          );
        }
        return 0;
      }
      case "tree": {
        const rootId = ctx.positionals[3];
        const tasks = await be.call<TaskStatus[]>("tasks", { room });
        if (rootId !== undefined && !tasks.some((status) => status.task.id === rootId)) {
          throw new Error(`no task ${rootId} in room ${room}`);
        }
        const tree = buildTaskTree(tasks, rootId);
        if (bool(ctx, "json")) json(tree);
        else if (tree.length === 0) out(dim(`no tasks in ${room}`));
        else renderTaskTree(tree);
        return 0;
      }
      default:
        usage("unknown task subcommand; use create, claim, update, show, list, tree, or agenda");
    }
  });
}

async function cmdAgenda(ctx: Ctx): Promise<number> {
  const limit = num(ctx, "limit");
  const includeUnclaimed = bool(ctx, "mine") ? false : undefined;
  return await withBackend(ctx, async (be) => {
    const agenda = await be.call<Agenda>("agenda", {
      ...(limit === undefined ? {} : { limit }),
      ...(includeUnclaimed === undefined ? {} : { includeUnclaimed }),
      // `true` asks the network for this agent's own profile capabilities.
      ...(bool(ctx, "capable") ? { includeCapable: true } : {}),
    });
    if (bool(ctx, "json")) json(agenda);
    else renderAgenda(agenda);
    return 0;
  });
}
