/**
 * What the agent a worker started can do about its own task (ADR 0029).
 *
 * These are actions of `oguri_task`, not tools of their own. The tool surface
 * is charged to every session on every task, and a test holds it to a budget,
 * so a capability that belongs to a task joins the task tool.
 *
 * A run is handed `OGURI_TASK_ID` and `OGURI_TASK_ROOM`, so it can report on
 * and ask about its own task without being told ids. A live agent can also
 * submit a plan it wrote itself, which skips the planner model call.
 */

import {
  PlanCreateError,
  PlanError,
  createPlanTasks,
  planSecretProblems,
  validatePlan,
  withDefaultTarget,
  type PlanWriter,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

type TextResult = { content: { type: "text"; text: string }[] };

function text(value: unknown): TextResult {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/** The room and task a run is working on, from its environment unless given. */
function currentTask(
  room: string | undefined,
  taskId: string | undefined,
  env: NodeJS.ProcessEnv,
): { room: string; taskId: string } {
  const resolvedRoom = room ?? env["OGURI_TASK_ROOM"];
  const resolvedTask = taskId ?? env["OGURI_TASK_ID"];
  if (resolvedRoom === undefined || resolvedRoom.length === 0) {
    throw new Error("no room: pass `room`, or run inside a worker run (OGURI_TASK_ROOM is unset)");
  }
  if (resolvedTask === undefined || resolvedTask.length === 0) {
    throw new Error("no task: pass `taskId`, or run inside a worker run (OGURI_TASK_ID is unset)");
  }
  return { room: resolvedRoom, taskId: resolvedTask };
}

/** How long `task_ask` may wait for an answer, polling the inbox. */
const MAX_WAIT_SEC = 3600;
const POLL_SEC = 30;

interface ThreadItem {
  id: string;
  from: string;
  body: string;
}

export function currentTaskOf(
  room: string | undefined,
  taskId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { room: string; taskId: string } {
  return currentTask(room, taskId, env);
}

/** `progress`: a `progressed` update on the run's own task. */
export async function taskProgress(
  backend: Backend,
  input: { body: string; room?: string | undefined; taskId?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextResult> {
  const target = currentTask(input.room, input.taskId, env);
  return text(
    await backend.call("taskUpdate", {
      ...target,
      input: { action: "progressed", body: input.body },
    }),
  );
}

/** `ask`: a question tied to the task, optionally waiting for a reply. */
export async function taskAsk(
  backend: Backend,
  input: {
    question: string;
    mentions?: string[] | undefined;
    needsHuman?: boolean | undefined;
    waitSec?: number | undefined;
    room?: string | undefined;
    taskId?: string | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextResult> {
  const target = currentTask(input.room, input.taskId, env);
  const sent = await backend.call<Message>("send", {
    room: target.room,
    input: {
      body: `[task ${target.taskId}] ${input.question}`,
      kind: "question",
      needs: input.needsHuman === true ? "human" : "agent",
      tags: ["task-question"],
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    },
  });
  const questionId = sent.header.id;
  const thread = sent.header.thread ?? questionId;
  const limit = Math.min(input.waitSec ?? 0, MAX_WAIT_SEC);
  if (limit === 0) {
    return text({ asked: questionId, thread, answered: false, note: "not waiting" });
  }

  const deadline = Date.now() + limit * 1000;
  while (Date.now() < deadline) {
    const slice = Math.max(1, Math.min(POLL_SEC, Math.ceil((deadline - Date.now()) / 1000)));
    const result = await backend.call<{ items: ThreadItem[]; timedOut: boolean }>("waitInbox", {
      query: { room: target.room, thread, timeoutMs: slice * 1000 },
    });
    const reply = result.items.find((item) => item.id !== questionId);
    if (reply !== undefined) {
      return text({ asked: questionId, thread, answered: true, reply });
    }
  }
  return text({
    asked: questionId,
    thread,
    answered: false,
    note: `no reply within ${String(limit)}s; this is not an answer. Continue, and state what you assumed.`,
  });
}

/** `plan`: validate a plan a live agent wrote, then create it. Nothing is written if it fails. */
export async function taskPlanCreate(
  backend: Backend,
  input: {
    room: string;
    goal?: string | undefined;
    defaultTarget?: string | undefined;
    plan: unknown;
  },
): Promise<TextResult & { isError?: true }> {
  try {
    const checked = withDefaultTarget(validatePlan(input.plan), input.defaultTarget);
    const secrets = planSecretProblems(checked, input.goal ?? checked.title);
    if (secrets.length > 0) throw new PlanError(secrets);
    const writer: PlanWriter = {
      createTask: async (room, taskInput) =>
        await backend.call<Message>("taskCreate", { room, input: taskInput }),
      claimTask: async (room, id, body) =>
        await backend.call<Message>("taskClaim", { room, taskId: id, body }),
    };
    const created = await createPlanTasks(
      writer,
      input.room,
      checked,
      input.goal === undefined ? {} : { goal: input.goal },
    );
    return text(created);
  } catch (error) {
    if (error instanceof PlanError) {
      return { ...text({ created: false, problems: error.problems }), isError: true };
    }
    if (error instanceof PlanCreateError) {
      return {
        ...text({ created: false, message: error.message, partial: error.created }),
        isError: true,
      };
    }
    throw error;
  }
}
