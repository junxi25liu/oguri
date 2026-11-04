/**
 * oguri intake (ADR 0030): turn a team chat's requests into tasks, and send
 * acknowledgements, questions, and results back where they were asked.
 */

export { DEFAULT_FEISHU_TIMEOUT_MS, FeishuApiError, FeishuClient } from "./feishu/client.ts";
export type { FeishuAppCredentials, FeishuClientOptions, FeishuRequest } from "./feishu/client.ts";
export { parseContent } from "./feishu/content.ts";
export type { FeishuMention, ParsedContent } from "./feishu/content.ts";
export { FeishuSource, advanceCursor, behindCursor, chatLink } from "./feishu/source.ts";
export type { FeishuMessageItem, FeishuSourceOptions } from "./feishu/source.ts";

export type { Addressed, InboundMessage, IntakeSource, SourceHealth } from "./source.ts";
export { IGNORE_REASONS, admit, chatFor } from "./admission.ts";
export type { Admission } from "./admission.ts";
export {
  CONTEXT_TAG,
  TITLE_LIMIT,
  followupMessage,
  taskOrigin,
  taskRequest,
  taskTitle,
} from "./request.ts";
export {
  DEDUPE_WINDOW_MS,
  emptyState,
  findTask,
  intakeDir,
  linkTask,
  readIntakeState,
  rebuildTaskMap,
  relayedKeys,
  writeIntakeState,
} from "./state.ts";
export type { ChatCursor, IntakeStateData, IntakeStatus, TaskLink } from "./state.ts";
export { Intake, claimTtlSeconds, intakeResource, intakeRooms, refusalText } from "./intake.ts";
export type { IntakeOptions, PollReport } from "./intake.ts";
export type { OutboundReply, Outbox } from "./outbox/types.ts";

export { IntakeReplies } from "./replies.ts";
export type { IntakeRepliesOptions } from "./replies.ts";
export { ReplyGoneError } from "./outbox/sender.ts";
export type { ReplySender, SentReply } from "./outbox/sender.ts";
export {
  FIRST_BACKOFF_MS,
  FileOutbox,
  MAX_BACKOFF_MS,
  OUTBOX_DIR,
  OUTBOX_RETENTION_MS,
  PROBLEM_AFTER,
  backoffMs,
} from "./outbox/file-outbox.ts";
export type {
  FileOutboxOptions,
  OutboxProblem,
  OutboxRecord,
  OutboxState,
  OutboxStatus,
} from "./outbox/file-outbox.ts";
export {
  FEISHU_GONE_CODES,
  FEISHU_UUID_LIMIT,
  FeishuReplySender,
  feishuReplyBody,
} from "./outbox/feishu-sender.ts";
export {
  WITHHELD_REPLY,
  composeReply,
  countWords,
  flattenText,
  limitWords,
  relaysFor,
} from "./relay.ts";
export type { ComposeOptions, RelayOptions, RelayTask } from "./relay.ts";
export {
  AUTO_GRACE_MS,
  AUTO_RESULT_WORDS,
  RELAY_CURSOR_FILE,
  RESCAN_LOOKBACK_MS,
  readCursor,
  roomReplies,
  scanRelays,
} from "./relay-scan.ts";
export type {
  RelayBackend,
  RelayCursor,
  RoomCursor,
  ScanOptions,
  ScanReport,
} from "./relay-scan.ts";
export {
  GH_TIMEOUT_MS,
  PRS_FILE,
  PR_CHECK_INTERVAL_MS,
  execGh,
  followPrs,
  isPrUrl,
  parsePrView,
  prUrlsIn,
  readPrState,
  taskPrs,
} from "./github/pr-follow.ts";
export type {
  FollowedPr,
  GhRunner,
  PrFile,
  PrFollowOptions,
  PrFollowReport,
  PrState,
  PrView,
  TaskPrs,
} from "./github/pr-follow.ts";
export { RelayPipeline, relayBackend } from "./relay-pipeline.ts";
export type { RelayPipelineOptions, TickReport } from "./relay-pipeline.ts";
