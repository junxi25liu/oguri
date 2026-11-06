# oguri 1.0.5

oguri is a team of AI coding agents on your own machines, coordinated through a Git repository
you own. You talk to one agent; it plans the work, deploys workers on the right machines, and tells
you when they are done or need you. This release covers everything since the published 1.0.1.

Version 1.0.2 was never published on its own: its changes ship here, together with 1.0.3 and 1.0.4.

## Upgrade

```console
npm i -g oguri@1.0.5
oguri daemon stop && oguri daemon start     # then restart `oguri superagent start` / `oguri worker start`
oguri doctor
```

- Your `~/.oguri/policy.yaml`, `config.yaml` and transport repository keep working unchanged. Every
  key that parsed in 1.0.1 still parses, and every new key is optional.
- **The default limit for one worker run is now 180 minutes** (was 60). The range is unchanged,
  1 to 1440. A policy that already writes `worker.timeoutMinutes` keeps its value; only a policy
  that leaves it out gets the new default.
- Runner grants stay off until the first `oguri runner grant`, so nothing stops working by
  upgrading.
- Upgrade every machine before using `oguri task update … relinked`: an older client rejects that
  new task action instead of misreading it.

New to oguri, or setting up a machine from scratch? The [deployment guide](docs/deploy.md) walks
the whole path from an empty machine to a running team, with a check after every step.

## What is new since 1.0.1

### Talking to your agents

- **`oguri chat`** is an interactive terminal conversation with the big superagent or any
  machine's small superagent, with separate history per target, late replies, and recovery after
  an interruption.
- **A `/chat` page** on the dashboard server does the same in a browser, with the same
  conversation service behind it. The dashboard's own endpoints stay read-only.
- A local superagent that shares your own agent id now shows its replies in chat instead of
  being treated as your own message.

### The dashboard

- A redesigned **execution centre** with overview, machines, tasks, and local runs, task detail,
  filtering, dark mode, a mobile layout, and links to Big and each machine's Small.
- It shows the **effective concurrency** and where it comes from (`worker.concurrency` or
  `superagent.small.maxWorkers`), reloads policy within two seconds, and is usable from the
  keyboard and with a screen reader.
- **Cost is labelled for what it is**: a known subtotal, with the number of runs it does not
  cover, counting worker runs only. A run is never counted as $0.
- **Model evidence is separated by source**: what the command line requested, what the CLI reported
  at start, and what the answer's usage reported. These are labels, not proof of which weights
  answered.

### Workers and runners

- **Runner tiers.** `worker.tiers` groups runners into rungs, cheapest first. Big and Small pick a
  rung for each worker with a reason, default to the cheapest, and a failed run of a tiered task
  climbs one rung, up to `worker.escalation.maxSteps` times. A person's follow-up may set its own
  `effort:`.
- **Runner grants.** A person at the machine's terminal grants each runner, bound to the entry as
  written and optionally limited to certain requesters or an expiry; revoking takes effect on the
  worker's next pass. Neither Big, Small nor a worker can grant itself a runner. Every action is
  audited. Agents can `request` a runner; asking grants nothing.
- **Configurable effort and concurrency.** A runner may set `effort` and an `efforts` allow-list;
  `worker.concurrency` and `superagent.small.maxWorkers` go up to 20, and the limit is shared by
  every worker process on one home.
- **A worker's run writes only to its own task** and its subtasks, and `worker.maxTaskDepth`
  bounds how deep a run may nest them.
- Tasks are taken by priority, then oldest first. A subtask's run receives its parent and its
  completed dependencies as context.
- A run that exits 0 without a `result.json` is reported as such, and `requireResult: true` makes
  it a retry. A rejected `result.json` never completes a task. A finished run whose result could
  not be published keeps it and retries until the task hears it. A background process a run left
  behind is stopped when the run ends.
- `oguri task update … relinked` lets the creator change an unclaimed task's dependencies; Big
  can relink, replace a cancelled task, and ask the owner to authorize a runner.
- `oguri runner presets` prints ready-made runner blocks. Their model names are placeholders:
  replace them with the models your own provider serves.

### Fixes

- `oguri daemon start` now says why when `OGURI_HOME` is so deep that the daemon's unix socket path
  exceeds the system limit, instead of only "did not come up".
- Several worker robustness fixes: concurrent runs of one repository all start, a run whose record
  cannot be written is handed back instead of staying claimed forever, and a run is judged by its
  process, not by a pipe a background job kept open.

## Known issues

- Windows has no packaged build; use WSL or build from source.
- The single-file binary is built per platform and cannot be copied between macOS and Linux or
  between arm64 and x64.
- Unix socket paths are limited to about 100 bytes, so a very long `OGURI_HOME` cannot host the
  daemon; keep it short.
- Cost figures are a known subtotal: runners that print no price are not counted.
- Model names are what the command line and the CLI report. A gateway in between may rewrite them.

## 中文

oguri 是一支运行在你自己机器上的 AI 编程 agent 团队，通过你自己的 Git 仓库协调。你只和一个 agent 对话，它规划工作、把 worker 派到合适的机器上，并在做完或需要你时告诉你。本次发行涵盖已发布的 1.0.1 之后的全部变化。

1.0.2 没有单独发布：它的改动连同 1.0.3、1.0.4 一起包含在这个版本里。

### 升级

```console
npm i -g oguri@1.0.5
oguri daemon stop && oguri daemon start     # 然后重启 `oguri superagent start` / `oguri worker start`
oguri doctor
```

- 你的 `~/.oguri/policy.yaml`、`config.yaml` 和传输仓库无需修改。1.0.1 能解析的每个键现在仍能解析，所有新键都是可选的。
- **单次运行的默认上限改为 180 分钟**（原为 60）。可设范围不变，仍是 1 到 1440。已有配置里写了 `worker.timeoutMinutes` 的保持原值，只有没写的才用新默认值。
- 在第一次 `oguri runner grant` 之前，runner 授权一直是关闭的，所以升级不会让任何东西停摆。
- 使用 `oguri task update … relinked` 之前，请先升级每台机器：老客户端会拒绝这个新的任务动作，而不是误读它。

第一次接触 oguri，或要从零部署一台机器？请按[部署指南](docs/zh-CN/deploy.md)走，从空机器到跑起来的团队，每一步都有确认方法。

### 1.0.1 之后的新内容

- **对话。** `oguri chat` 是和 Big 或某台机器 Small 的终端连续对话，每个目标的历史各自独立，支持迟到的回复和中断恢复；看板服务上新增 `/chat` 页面，背后是同一个对话服务，看板自己的接口依旧只读。与你同一个 agent id 的本机 superagent，其回复现在会显示在聊天里。
- **看板。** 重新设计的执行中心：总览、机器、任务和本地运行，任务详情、筛选、深色模式、移动端布局；显示生效的并发数及其来源；可用键盘和读屏软件操作；费用标成"已知小计"并说明有多少次运行不在其中，只统计 worker 运行，从不把一次运行按 $0 计；模型证据按来源分开显示（argv 请求的、CLI 启动时报告的、回答 usage 里报告的），这些只是标签，不证明是哪个权重在回答。
- **分档位。** `worker.tiers` 把 runner 从便宜到贵分档；Big 和 Small 为每个 worker 选一档并写明原因，默认最便宜的；分档任务失败后最多升 `worker.escalation.maxSteps` 档；人的追问可以单独设置 `effort:`。
- **Runner 授权。** 由本机终端前的人给每个 runner 授权，绑定到当前写法，可限定请求者或设有效期，撤销在 worker 下一轮生效；Big、Small、worker 都不能给自己授权，所有操作都有审计；agent 可以 `request`，但申请不授予任何东西。
- **effort 与并发。** runner 可设 `effort` 和 `efforts` 白名单；`worker.concurrency` 与 `superagent.small.maxWorkers` 上限提高到 20，同一个 home 下的所有 worker 进程共用这个限额。
- **worker 的运行只能写自己的任务**及其子任务，`worker.maxTaskDepth` 限制子任务的嵌套深度；任务按优先级、再按先后顺序领取；子任务的运行会拿到父任务和已完成依赖的上下文。
- 退出码 0 却没写 `result.json` 的运行会如实说明，`requireResult: true` 让它改为重试；被拒绝的 `result.json` 不会让任务完成；结果没能发布的运行会保留结果并重试，直到任务收到；运行留下的后台进程在运行结束时被停掉。
- `oguri task update … relinked` 让创建者修改未认领任务的依赖；Big 能重连依赖、替换被取消的任务、请求主人授权 runner。
- `oguri runner presets` 打印现成的 runner 写法，其中的模型名是占位符，请换成你自己的 provider 提供的模型。
- **修复。** `oguri daemon start` 在 `OGURI_HOME` 太深、导致 daemon 的 unix socket 路径超过系统上限时，会说明真正的原因，而不再只说"没起来"；以及若干 worker 稳健性修复。

### 已知问题

- Windows 没有打包版本，请用 WSL 或从源码构建。
- 单文件二进制按平台构建，不能在 macOS 与 Linux、arm64 与 x64 之间互相拷贝。
- unix socket 路径限制在约 100 字节，所以过长的 `OGURI_HOME` 没法托管 daemon，请保持简短。
- 费用是"已知小计"：不打印价格的 runner 不计入。
- 模型名是命令行请求的和 CLI 报告的；中间的 gateway 可能改写它们。
