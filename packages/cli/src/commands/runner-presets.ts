/**
 * `oguri runner presets` — print runner blocks to paste into `policy.yaml`.
 *
 * Every block here works with the policy parser as it is today. In particular
 * none of them uses a `model:` key: a runner names its model in its own argv
 * (`--model <m>` for claude, `-m <m>` for codex), which is the only form the
 * current parser accepts. A `model:` field would make these blocks fail to
 * parse, so adding one is a separate change, and this command must not depend
 * on it.
 *
 * The command only prints. It never writes `policy.yaml`, and never looks at
 * whether a runner is enabled: what a run may execute stays the machine
 * owner's decision, the same rule `oguri worker mcp-config` follows.
 */

import type { SessionMode } from "@oguri/core";

import { type Ctx, bool, usage } from "../context.ts";
import { bold, dim, json, out } from "../output.ts";

/** One runner, exactly as `worker.runners.<name>` accepts it. */
export interface PresetRunner {
  argv: string[];
  resume?: string[];
  session?: SessionMode;
  worktree?: boolean;
  workdir?: string;
  oguriTools?: boolean;
}

/** A pasteable runner, with the bilingual comment a person reads above it. */
export interface RunnerPreset {
  name: string;
  titleZh: string;
  titleEn: string;
  noteZh: string;
  noteEn: string;
  runner: PresetRunner;
}

/** The worker flags that let a CLI agent edit files and run checks, but never push. */
const WORKER_TOOLS = [
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash(pnpm:*)",
  "Bash(node:*)",
  "Bash(git:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "--disallowedTools",
  "Bash(git push:*)",
];

/** The stream-json flags a live session needs, then the model when one is named. */
function claudeStream(model: string | undefined, ...extra: string[]): string[] {
  return [
    "claude",
    "-p",
    ...(model === undefined ? [] : ["--model", model]),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...extra,
  ];
}

/** A live Claude session that may edit and run commands, as a worker needs it. */
function liveClaude(model: string | undefined): string[] {
  return claudeStream(model, ...WORKER_TOOLS);
}

/** A live session's resume form: the same argv, plus the id it continues. */
function resuming(argv: readonly string[]): string[] {
  return [...argv, "--resume", "{session}"];
}

/**
 * The presets, in the order a person sets them up: the general-purpose ones
 * first, the cheap ones next, and the superagents' brains last.
 *
 * `worktree: true` needs a repository to branch, so the two cheap runners carry
 * their own `workdir`; a person changes that path to their own checkout. It
 * also means either may be pasted into a policy that sets no `worker.workdir`.
 */
export const RUNNER_PRESETS: readonly RunnerPreset[] = [
  {
    name: "claude-live",
    titleZh: "Claude 活会话：可改文件、可跑命令，跑的过程中还能收到人的消息",
    titleEn: "Claude live session: edits files, runs commands, takes a person's message mid-run",
    noteZh:
      "每个任务一个 git worktree，互不共享检出。先改自己那块，跑 pnpm build 和测试，再 git commit。workdir 换成你自己的仓库。",
    noteEn:
      "One git worktree per task, so concurrent runs never share a checkout. Change your own part, run pnpm build and the tests, then git commit. Point workdir at your own repository.",
    runner: {
      argv: liveClaude(undefined),
      resume: resuming(liveClaude(undefined)),
      session: "claude-stream",
      worktree: true,
      workdir: "~/src/app",
    },
  },
  {
    name: "claude-json",
    titleZh: "Claude 一次性会话：每轮一个进程，靠 resume 续上同一个会话",
    titleEn: "Claude JSON session: one process per turn, resumed for a follow-up",
    noteZh:
      "比活会话简单：没有长驻进程，也没有运行中插话。任务结束后人在同一线程追问，worker 用 resume 接着跑。",
    noteEn:
      "Simpler than a live session: no long-lived process and no mid-run steering. A person's follow-up in the same thread resumes the session.",
    runner: {
      argv: ["claude", "-p", "--output-format", "json"],
      resume: ["claude", "-p", "--output-format", "json", "--resume", "{session}"],
      session: "claude-json",
    },
  },
  {
    name: "codex-exec",
    titleZh: "Codex exec：JSON 行输出，按 thread id 续会话",
    titleEn: "Codex exec: JSON lines, resumed by thread id",
    noteZh:
      "任务正文从 stdin 进（末尾的 - 就是它）。--skip-git-repo-check 让它在非 git 目录也能跑；要 worktree 就自己加 workdir 和 worktree: true。",
    noteEn:
      "The task text arrives on stdin (that is the trailing `-`). `--skip-git-repo-check` lets it run outside a git directory; add workdir and worktree: true yourself for a fresh checkout per run.",
    runner: {
      argv: ["codex", "exec", "--json", "--skip-git-repo-check", "-"],
      resume: ["codex", "exec", "--json", "resume", "{session}", "-"],
      session: "codex-jsonl",
    },
  },
  {
    name: "dsk",
    titleZh: "便宜模型 deepseek-v4.1-flash：活会话，适合直接的实现",
    titleEn: "Cheap model deepseek-v4.1-flash: a live session for direct implementation",
    noteZh:
      "模型写在 argv 里，不依赖 model: 字段。claude 要能访问这个模型，比如把 ANTHROPIC_BASE_URL 指向 DeepSeek 的 Anthropic 兼容接口。能改文件、跑 pnpm/node/git/ls/cat；git push 被显式禁掉。",
    noteEn:
      "The model is named in the argv, not in a model: key. claude must be able to reach it, for example with ANTHROPIC_BASE_URL pointing at DeepSeek's Anthropic-compatible API. It may edit files and run pnpm/node/git/ls/cat; git push is explicitly denied.",
    runner: {
      argv: liveClaude("deepseek-v4.1-flash"),
      resume: resuming(liveClaude("deepseek-v4.1-flash")),
      session: "claude-stream",
      worktree: true,
      workdir: "~/src/app",
    },
  },
  {
    name: "brain",
    titleZh: "给 big superagent 用的无工具 brain：常驻会话",
    titleEn: "The big superagent's no-tool brain: a standing session",
    noteZh:
      "--tools= 关掉全部工具：superagent 只做判断和安排，真正的活是 worker 的任务。oguriTools: false 再关掉 oguri 自己加的 MCP 工具。",
    noteEn:
      "--tools= turns every tool off: a superagent only decides and dispatches, while the actual work stays a task a worker runs. oguriTools: false also keeps oguri's own MCP tools out of its argv.",
    runner: {
      argv: claudeStream("claude-opus-5.5", "--effort", "high", "--tools="),
      resume: resuming(claudeStream("claude-opus-5.5", "--effort", "high", "--tools=")),
      session: "claude-stream",
      oguriTools: false,
    },
  },
  {
    name: "brain-lite",
    titleZh: "给 small superagent 用的便宜 brain：无工具，常驻会话",
    titleEn: "The small superagent's cheap brain: no tools, standing session",
    noteZh: "本机的小 superagent 用它汇报和回答，不必花 Opus 的钱。",
    noteEn:
      "A small superagent on the same machine reports and answers with this instead of spending Opus money.",
    runner: {
      argv: claudeStream("deepseek-v4.1-flash", "--tools="),
      resume: resuming(claudeStream("deepseek-v4.1-flash", "--tools=")),
      session: "claude-stream",
      oguriTools: false,
    },
  },
];

/** One YAML string, quoted the way a YAML flow sequence accepts it. */
function flow(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}

/**
 * A preset's lines, at `indent` under `worker.runners:`.
 *
 * Every scalar is JSON-quoted: a JSON string is also a YAML double-quoted
 * scalar, so an argument such as `Bash(pnpm:*)` can never be read as syntax.
 */
export function presetYaml(preset: RunnerPreset, indent = "    "): string[] {
  const lines = [
    `${indent}# ${preset.titleZh}`,
    `${indent}# ${preset.titleEn}`,
    `${indent}#`,
    `${indent}# ${preset.noteZh}`,
    `${indent}# ${preset.noteEn}`,
    `${indent}${preset.name}:`,
    `${indent}  argv: ${flow(preset.runner.argv)}`,
  ];
  const { resume, session, workdir, worktree, oguriTools } = preset.runner;
  if (resume !== undefined) lines.push(`${indent}  resume: ${flow(resume)}`);
  if (session !== undefined) lines.push(`${indent}  session: ${session}`);
  if (worktree === true) lines.push(`${indent}  worktree: true`);
  if (workdir !== undefined) lines.push(`${indent}  workdir: ${JSON.stringify(workdir)}`);
  if (oguriTools === false) lines.push(`${indent}  oguriTools: false`);
  return lines;
}

/** Every preset as one `worker:` block, which is what a person pastes. */
export function presetsYaml(): string[] {
  const lines = [
    "worker:",
    "  runners:",
    ...RUNNER_PRESETS.flatMap((preset) => [...presetYaml(preset), ""]),
  ];
  // A trailing blank line inside the block would be harmless; a trailing comment
  // reminding about the two keys that must name an entry is more useful.
  lines.push("  # 下面两个名字必须是上面 runner 的名字");
  lines.push("  # Both names must be a key of worker.runners above.");
  lines.push("  # defaultRunner: dsk");
  lines.push("  # plannerRunner: brain");
  return lines;
}

/**
 * `oguri runner <subcommand>`. `presets` is the whole command today; the bare
 * form does the same thing, because printing is what someone typing it wants.
 */
export async function cmdRunner(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "presets";
  if (sub !== "presets") usage(`unknown runner subcommand '${sub}'; use presets`);
  return await cmdRunnerPresets(ctx);
}

/** `oguri runner presets [--json]` — print the blocks; change nothing. */
export async function cmdRunnerPresets(ctx: Ctx): Promise<number> {
  if (bool(ctx, "json")) {
    json({
      presets: RUNNER_PRESETS.map((preset) => ({
        name: preset.name,
        title: { zh: preset.titleZh, en: preset.titleEn },
        note: { zh: preset.noteZh, en: preset.noteEn },
        runner: preset.runner,
        yaml: presetYaml(preset)
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n"),
      })),
      yaml: presetsYaml().join("\n"),
    });
    return 0;
  }

  out(bold("runner presets"));
  out(dim("Paste this into ~/.oguri/policy.yaml, change the paths, and keep the runners you use."));
  out(dim("粘进 ~/.oguri/policy.yaml，按自己的路径改，留下要用的 runner。"));
  out(
    dim(
      "Already have a `worker:` section? Copy only the entries under `runners:`, not the `worker:` line.",
    ),
  );
  out(dim("已经有 worker: 段的话，只复制 runners: 下面的条目，不要复制 worker: 这一行。"));
  out("");
  out(
    dim(
      "No block uses a model: key — each runner names its model in its own argv, which is what this version parses.",
    ),
  );
  out(dim("每段都把模型写在 argv 里，不依赖 model: 字段，当前版本就能用。"));
  out(dim("oguri 只读 policy.yaml，从不改写它。It never edits the file."));
  out("");
  for (const line of presetsYaml()) out(line);
  out("");
  out(dim("Then:  oguri policy     # what oguri read back"));
  out(dim("       oguri doctor     # each runner's command is on PATH"));
  return 0;
}

/** The preset names, in the order they print. */
export const PRESET_NAMES: readonly string[] = RUNNER_PRESETS.map((preset) => preset.name);
