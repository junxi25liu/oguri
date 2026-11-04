/**
 * @oguri/superagent (ADR 0031): one agent to talk to, and a keeper on every machine.
 *
 * The big superagent decides which workers to deploy and where, passes
 * messages to them, moves or stops them, and answers you. The small
 * superagent on each machine looks after that machine's workers and reports
 * upward; you can also talk to it directly. A worker is one task's agent
 * session, run by the machine's worker engine. Everything is a message in the
 * transport repository, which every agent on every machine reads.
 */

export {
  MAX_READ_TASKS,
  ROUTE_KINDS,
  ROUTE_LIMITS,
  RouteError,
  extractJson,
  parseRouteDecision,
  unwrapEnvelope,
} from "./decision.ts";
export type { RouteDecision, RouteKind, RoutePlanStep, RouteScope } from "./decision.ts";
export { askModel, resolveThinker } from "./model.ts";
export type { AskModel, ModelResult, RouterRunner } from "./model.ts";
export { buildPrompt } from "./prompt.ts";
export type { PromptOptions, RouteRequest, SuperagentRole } from "./prompt.ts";
export {
  BIG_KINDS,
  COORDINATOR_KINDS,
  FROM_SUPERAGENT_TAG,
  MAX_READ_ROUNDS,
  MAX_ROUTE_STEPS,
  SMALL_KINDS,
  SMALL_REPORT_TAG,
  TO_BIG_TAG,
  TO_SMALL_TAG,
  act,
  decide,
  ensureRoom,
  readDetails,
  reply,
  superagentMandate,
  taskDefinition,
} from "./act.ts";
export type { ActContext, Acted, Conversation, DecideOptions, Decided } from "./act.ts";
export {
  BigSuperagent,
  HANDBACK_TAG,
  QUESTION_TAG,
  contextOf,
  isBigRequest,
  toldText,
  workRoom,
  workerRooms,
} from "./big.ts";
export type { BigOptions, BigReport } from "./big.ts";
export { SmallSuperagent, attentionNote, isSmallRequest } from "./small.ts";
export type { SmallOptions, SmallReport, SmallReportTask } from "./small.ts";
export { loadSnapshot, renderSnapshot, scopeOf } from "./snapshot.ts";
export type { Snapshot, SnapshotAgent, SnapshotMachine, SnapshotTask } from "./snapshot.ts";
export { readSuperagentState, stateFile, writeSuperagentState } from "./state.ts";
export type { SuperagentState, Tracked } from "./state.ts";

export { langOf, shortId, words, type Lang } from "./words.ts";
export { PLAN_STEP_NOTE } from "./act.ts";
