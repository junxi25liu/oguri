import { readFile } from "node:fs/promises";

import {
  type Plan,
  PlanCreateError,
  PlanError,
  createPlanTasks,
  loadLocalPolicy,
  parsePlan,
  planOrder,
  planSecretProblems,
  withDefaultTarget,
  type MachineRow,
  type PlanWriter,
} from "@oguri/core";
import type { Message } from "@oguri/protocol";
import {
  assertAgentId,
  assertMachineId,
  assertRoomId,
  isMachineToken,
  machineMention,
} from "@oguri/protocol";
import type { Backend } from "@oguri/daemon";

import { type Ctx, bool, list, num, str, usage } from "../context.ts";
import { bold, cyan, dim, green, json, out, red, yellow } from "../output.ts";
import {
  buildPlanPrompt,
  resolvePlannerRunner,
  rosterFrom,
  runPlanner,
  type RosterMachine,
} from "../planner.ts";
import { withBackend } from "../with-backend.ts";

/** What the planner asks a backend for: write tasks. Adapts `Backend` to `PlanWriter`. */
export function backendWriter(backend: Backend): PlanWriter {
  return {
    createTask: async (room, input) => await backend.call<Message>("taskCreate", { room, input }),
    claimTask: async (room, taskId, body) =>
      await backend.call<Message>("taskClaim", { room, taskId, body }),
  };
}

/** Who is on the network and what each agent says it can do, for the planning prompt. */
export async function loadRoster(backend: Backend): Promise<RosterMachine[]> {
  const machines = await backend.call<MachineRow[]>("machines").catch(() => []);
  const capabilities = new Map<string, readonly string[]>();
  for (const machine of machines) {
    for (const agent of machine.agents) {
      const profile = await backend
        .call<{ capabilities?: string[] } | null>("profileGet", { agent: agent.id })
        .catch(() => null);
      capabilities.set(agent.id, profile?.capabilities ?? []);
    }
  }
  return rosterFrom(machines, capabilities);
}

/** The plan as an indented tree of keys, titles, and the edges that order it. */
export function renderPlan(plan: Plan): string {
  const lines = [bold(plan.title), ""];
  for (const task of planOrder(plan)) {
    const edges: string[] = [];
    if (task.dependsOn.length > 0) edges.push(`after ${task.dependsOn.join(", ")}`);
    if (task.requires.length > 0) edges.push(`needs ${task.requires.join(", ")}`);
    if (task.target !== undefined) edges.push(`for ${task.target}`);
    if (task.maxAttempts !== undefined) edges.push(`${String(task.maxAttempts)} attempts`);
    lines.push(
      `  ${cyan(task.key.padEnd(18))} ${task.title}${edges.length > 0 ? dim(`  (${edges.join("; ")})`) : ""}`,
    );
  }
  return lines.join("\n");
}

async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** `--target` for the whole plan: a step that names no target gets this one. */
function planTarget(ctx: Ctx): string | undefined {
  const target = str(ctx, "target");
  const machines = list(ctx, "machine");
  if (target !== undefined && machines.length > 0) {
    usage("use either --target or --machine, not both");
  }
  if (machines.length > 1) usage("a plan can default to one machine, not several");
  const machine = machines[0];
  if (machine !== undefined) return machineMention(assertMachineId(machine));
  if (target === undefined) return undefined;
  return isMachineToken(target) ? target : assertAgentId(target);
}

/** A plan from a model, or from `--from-file`. Returns the plan and where it came from. */
async function obtainPlan(
  ctx: Ctx,
  backend: Backend,
  room: string,
  goal: string,
): Promise<{ plan: Plan; source: string }> {
  const file = str(ctx, "from-file");
  if (file !== undefined) {
    const text = await readFile(file, "utf8");
    return { plan: parsePlan(text), source: file };
  }

  const { policy } = await loadLocalPolicy(ctx.layout);
  const runner = resolvePlannerRunner(policy.worker, str(ctx, "runner"));
  const prompt = buildPlanPrompt(goal, room, await loadRoster(backend));
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // Progress is for a person. With --json, stdout must hold one JSON document.
  if (!bool(ctx, "json")) {
    out(
      dim(
        `asking planner runner '${runner.name}' (up to ${String(policy.worker.timeoutMinutes)} min)...`,
      ),
    );
  }
  try {
    const result = await runPlanner({
      argv: runner.argv,
      cwd: runner.cwd,
      prompt,
      timeoutMs: policy.worker.timeoutMinutes * 60_000,
      signal: controller.signal,
    });
    if (result.error !== undefined) {
      throw new Error(`the planner runner could not start: ${result.error}`);
    }
    if (controller.signal.aborted) throw new Error("cancelled");
    if (result.timedOut) {
      throw new Error(
        `the planner ran past ${String(policy.worker.timeoutMinutes)} minutes and was stopped`,
      );
    }
    if (result.exitCode !== 0) {
      const tail = result.stderrTail.trim().split("\n").slice(-3).join(" | ");
      throw new Error(
        `the planner runner exited with ${String(result.exitCode ?? result.signal)}${tail.length > 0 ? `: ${tail}` : ""}`,
      );
    }
    return { plan: parsePlan(result.stdout), source: `runner ${runner.name}` };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * `oguri plan <room> "<goal>"` -- break a goal into a graph of tasks.
 *
 * A model proposes the plan; nothing is written until the whole plan has been
 * validated and shown. `--dry-run` stops there. Without `--yes` a person is
 * asked, and a non-interactive run that was not told `--yes` writes nothing.
 * `--from-file` skips the model and takes a hand-written plan.
 */
export async function cmdPlan(ctx: Ctx): Promise<number> {
  const room = assertRoomId(ctx.positionals[1] ?? usage('usage: oguri plan <room> "<goal>"'));
  const goal = (ctx.positionals[2] ?? "").trim();
  const fromFile = str(ctx, "from-file");
  if (goal.length === 0 && fromFile === undefined) {
    usage('usage: oguri plan <room> "<goal>" (or --from-file plan.json)');
  }
  const dryRun = bool(ctx, "dry-run");
  const asJson = bool(ctx, "json");
  const target = planTarget(ctx);
  void num;

  return await withBackend(ctx, async (backend) => {
    let obtained: { plan: Plan; source: string };
    try {
      obtained = await obtainPlan(ctx, backend, room, goal);
    } catch (error) {
      if (error instanceof PlanError) {
        out(red("the plan is not valid:"));
        for (const problem of error.problems) out(`  - ${problem}`);
        return 1;
      }
      throw error;
    }
    const plan = withDefaultTarget(obtained.plan, target);
    const effectiveGoal = goal.length > 0 ? goal : plan.title;

    const secrets = planSecretProblems(plan, effectiveGoal);
    if (secrets.length > 0) {
      out(red("the plan contains what looks like a secret and was not created:"));
      for (const problem of secrets) out(`  - ${problem}`);
      return 1;
    }

    if (asJson && dryRun) {
      json({ source: obtained.source, plan });
      return 0;
    }
    if (!asJson) {
      out(`${dim(`plan from ${obtained.source}`)}\n`);
      out(renderPlan(plan));
      out("");
    }
    if (dryRun) {
      out(dim("dry run: nothing was created"));
      return 0;
    }
    if (
      !bool(ctx, "yes") &&
      !(await confirm(`Create ${String(plan.tasks.length)} task(s) in ${room}?`))
    ) {
      out(yellow("not created. Re-run with --yes to create without asking."));
      return 1;
    }

    try {
      // Inside a worker's run the steps go under its own task, as over MCP (ADR 0036).
      await backend.runScope?.assertCreate(room, undefined);
      const created = await createPlanTasks(backendWriter(backend), room, plan, {
        goal: effectiveGoal,
        ...(backend.runScope === undefined ? {} : { parent: backend.runScope.taskId }),
      });
      if (asJson) {
        json(created);
        return 0;
      }
      out(
        `${green("created")} parent ${bold(created.parent.id)} ${created.parentClaimed ? "(claimed by you)" : yellow("(not claimed: " + (created.claimError ?? "unknown") + ")")}`,
      );
      for (const task of created.tasks) out(`  ${task.id}  ${cyan(task.key)}  ${task.title}`);
      out(dim(`\nsee the graph:  oguri task tree ${room} ${created.parent.id}`));
      return 0;
    } catch (error) {
      if (error instanceof PlanError) {
        out(red("the plan was not created:"));
        for (const problem of error.problems) out(`  - ${problem}`);
        return 1;
      }
      if (error instanceof PlanCreateError) {
        out(red(error.message));
        out(dim(`cancel what exists with:  oguri task update ${room} <id> cancelled "reason"`));
        return 1;
      }
      throw error;
    }
  });
}
