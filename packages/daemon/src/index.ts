export { Daemon } from "./daemon.ts";
export type { DaemonOptions } from "./daemon.ts";

export { DaemonClient, DaemonUnavailableError, DaemonRequestError } from "./client.ts";

export {
  MAX_PARENT_HOPS,
  RunScope,
  RunScopeError,
  RunScopedBackend,
  isDescendant,
  openBackend,
  runOf,
  scopeToRun,
  taskDepth,
} from "./backend.ts";
export type { Backend, OpenBackendOptions } from "./backend.ts";

export { SyncLoop } from "./loop.ts";
export type { SyncLoopOptions } from "./loop.ts";

export { createNotifier, shouldNotify, sanitize, NOTIFIER_KINDS } from "./notify.ts";
export type { Notifier, NotifierKind, Notification } from "./notify.ts";

export {
  PUSH_EXCERPT_CHARS,
  PUSH_TIMEOUT_MS,
  PushDispatcher,
  PushRateLimit,
  buildPushRequest,
  channelWants,
  composePush,
  matchPushRules,
  neutraliseMarkdown,
  pushEventFor,
  sendPush,
  testPushEvent,
  trimText,
} from "./push.ts";
export type {
  PushDispatcherOptions,
  PushEvent,
  PushReason,
  PushResult,
  PushSelf,
  PushText,
} from "./push.ts";

export {
  METHODS,
  DAEMON_ONLY_METHODS,
  IPC_PROTOCOL_VERSION,
  LineFramer,
  encode,
  isMethod,
  isDaemonOnlyMethod,
} from "./protocol.ts";
export type {
  Method,
  DaemonOnlyMethod,
  DirectMethod,
  IpcRequest,
  IpcResponse,
} from "./protocol.ts";

export {
  detectSupervisor,
  installService,
  uninstallService,
  isServiceInstalled,
  renderUnit,
  unitPath,
  SERVICE_LABEL,
  DAEMON_SERVICE,
} from "./supervisor.ts";
export type { SupervisorKind, InstallResult, ServiceSpec } from "./supervisor.ts";
export { FEISHU_API, FeishuTokenCache, feishuApiBase, feishuTokens } from "./feishu-app.ts";
