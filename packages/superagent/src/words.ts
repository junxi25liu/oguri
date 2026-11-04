/**
 * The words a superagent's own code says to the owner, in the owner's
 * language. The model writes acknowledgements and answers in that language
 * already; these are the lines code adds around them.
 */

export type Lang = "zh" | "en";

/** Chinese when the owner wrote any Han characters, otherwise English. */
export function langOf(text: string): Lang {
  return /[\u3400-\u9fff]/u.test(text) ? "zh" : "en";
}

/** The last six characters of an id: enough to tell tasks apart, short enough to read. */
export function shortId(id: string): string {
  return id.slice(-6);
}

const EN = {
  deployedOne: (where: string, id: string) => `Worker deployed on ${where}: task ${shortId(id)}.`,
  deployedMany: (count: number, parent: string) =>
    `${String(count)} workers deployed (plan ${shortId(parent)}):`,
  step: (title: string, id: string) => `- ${title} (task ${shortId(id)})`,
  passed: (title: string, id: string) => `Passed to the worker on ${title} (task ${shortId(id)}).`,
  moved: (title: string, target: string) => `Moved the worker for ${title} to ${target}.`,
  stopped: (title: string) => `Stopped the worker for ${title}.`,
  done: (title: string) => `Done: ${title}`,
  waiting: (title: string) => `Waiting on you: ${title}`,
  undecided: (why: string) =>
    `I could not decide what to do with this, so nothing was started. Why: ${why}`,
  undecidedOn: (machine: string, why: string) =>
    `I could not decide what to do with this on ${machine}, so nothing was started. Why: ${why}`,
  failed: (kind: string, why: string) => `I decided to ${kind}, but it failed: ${why}`,
  merged: (url: string) => `PR merged: ${url}`,
  closed: (url: string) => `PR closed without merging: ${url}`,
  follow: "Follow it with: oguri superagent status",
};

const ZH: typeof EN = {
  deployedOne: (where, id) => `已在 ${where} 部署 worker：任务 ${shortId(id)}。`,
  deployedMany: (count, parent) => `已部署 ${String(count)} 个 worker（计划 ${shortId(parent)}）：`,
  step: (title, id) => `- ${title}（任务 ${shortId(id)}）`,
  passed: (title, id) => `已转给「${title}」的 worker（任务 ${shortId(id)}）。`,
  moved: (title, target) => `已把「${title}」的 worker 改派到 ${target}。`,
  stopped: (title) => `已停止「${title}」的 worker。`,
  done: (title) => `完成：${title}`,
  waiting: (title) => `等你回复：${title}`,
  undecided: (why) => `我没能判断该怎么处理这条消息，所以什么都没启动。原因：${why}`,
  undecidedOn: (machine, why) =>
    `我没能判断在 ${machine} 上该怎么处理这条消息，所以什么都没启动。原因：${why}`,
  failed: (kind, why) => `我决定 ${kind}，但执行失败了：${why}`,
  merged: (url) => `PR 已合并：${url}`,
  closed: (url) => `PR 未合并就关闭了：${url}`,
  follow: "查看进度：oguri superagent status",
};

export function words(lang: Lang): typeof EN {
  return lang === "zh" ? ZH : EN;
}
