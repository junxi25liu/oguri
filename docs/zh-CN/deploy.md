# 在一台新机器上部署 oguri

这是从一台空机器到一支能接活的团队的完整路径：安装、连接传输仓库、配置 worker 和 superagent、加第二台机器、日常运维。每一步都给出可复制的命令，以及"怎么确认这一步成功"。哪一步和描述不一致，直接跳到[排障](#10-排障)。

先记住两件事，后面就好懂：

- **传输仓库是你自己的一个 Git 仓库。** 机器之间从不直接通信，只通过它推拉消息；能 `git push` 到它的机器就是团队的一员。
- **机器的主人不点头，什么都不会跑。** 一台机器能执行什么，只由本机的一个文件 `~/.oguri/policy.yaml` 决定；oguri 只读不写，网络上的任何消息都改不了它。

目录：[1 前置条件](#1-前置条件) · [2 安装](#2-安装) · [3 第一台机器](#3-第一台机器) · [4 配置策略](#4-配置策略) · [5 和 superagent 对话](#5-和-superagent-对话) · [6 加第二台机器](#6-加第二台机器) · [7 日常运维](#7-日常运维) · [8 从 1.0.1 升级](#8-从-101-升级) · [9 安全模型](#9-安全模型) · [10 排障](#10-排障) · [11 不花钱验证整条链路](#11-不用付费模型验证整条链路)

## 1. 前置条件

| 需要                           | 原因                                                 | 检查                    |
| ------------------------------ | ---------------------------------------------------- | ----------------------- |
| macOS 或 Linux（x64 或 arm64） | Windows 没有打包版本，请用 WSL                       | `uname -sm`             |
| Node.js 24 及以上              | oguri 运行在它上面（用单文件二进制则不需要）         | `node --version`        |
| Git 2.42 及以上                | 房间是孤立 worktree，`worktree add --orphan` 要 2.42 | `git --version`         |
| 一个 Git 身份                  | 每条消息都是一个提交                                 | `git config user.email` |
| Claude Code 或 Codex CLI       | worker 真正执行的东西；只转发消息的机器可以不装      | `claude --version`      |
| 该 CLI 已登录                  | worker 没法回答登录提示                              | 手动运行一次 `claude`   |
| pnpm（仅从源码构建时）         | `pnpm install && pnpm build`                         | `pnpm --version`        |
| 一个传输仓库                   | 见下                                                 | `git ls-remote <url>`   |

**传输仓库**必须是专用的、空的、**bare** 仓库，不是你的业务仓库。消息是孤立分支上的提交；检出了 `main` 的非 bare 仓库会拒绝 push。三选一：

| 传输仓库                      | 适用                    | 创建                                          |
| ----------------------------- | ----------------------- | --------------------------------------------- |
| GitHub 或 GitLab 上的私有仓库 | 机器在不同网络          | 建一个空的私有仓库，给每台机器 push 权限      |
| 共享路径上的 bare 仓库        | 机器共用文件系统（NFS） | `git init --bare /shared/oguri-transport.git` |
| 本机的 bare 仓库              | 单机，或试用            | `git init --bare ~/oguri-transport.git`       |

能 push 到传输仓库的人都能给你的 superagent 发话，所以请只对你自己的机器开放。消息是永久的，不要把密钥写进去（oguri 的扫描器会拒绝明显的密钥）。

## 2. 安装

任选一种。四种都会在 `PATH` 上放一个 `oguri`，都不用 `sudo`。

| 方式         | 适用                                | 命令                                                            |
| ------------ | ----------------------------------- | --------------------------------------------------------------- |
| npm          | 机器有 Node 24+（最常见）           | `npm i -g oguri`                                                |
| `install.sh` | 想装发行版二进制，且有 `gh` 或 curl | `./install.sh`                                                  |
| 单文件二进制 | 目标机器没有 Node                   | `pnpm binary`，然后 `./install.sh --from-binary dist-bin/oguri` |
| 源码         | 你要改 oguri 本身                   | `./install.sh --source-dir .`（需要 pnpm）                      |

```console
npm i -g oguri
oguri --version
```

应当看到版本号，比如 `1.0.5`。如果提示 `command not found`，说明 npm 全局 `bin` 目录不在 `PATH` 上；`npm prefix -g` 会打印它的位置。

单文件二进制按平台构建，不能在 macOS 和 Linux 之间、arm64 和 x64 之间互相拷贝：请在同类机器上构建。

```console
# 在有源码的构建机器上
pnpm install && pnpm binary                         # 生成 dist-bin/oguri
scp dist-bin/oguri gpu-box:/tmp/oguri
ssh gpu-box ./install.sh --from-binary /tmp/oguri   # 装到 ~/.local/bin
```

`install.sh` 装到 `~/.local/bin`；如果该目录不在 `PATH` 上，它会打印要加的那一行，从不改你的 shell 配置。

## 3. 第一台机器

### 3.1 初始化

给 agent 起个有意义的名字，它会永久标识每条消息的作者。

```console
oguri init --repo git@github.com:acme/oguri-transport.git --agent alice-mac
```

本地 bare 仓库也一样（直接写路径，不要加 `file://`）：

```console
git init --bare ~/oguri-transport.git
oguri init --repo ~/oguri-transport.git --agent alice-mac
```

成功的样子：

```text
✓ initialised a new network
✓ agent card published as alice-mac
✓ config written to /home/user/.oguri/config.yaml
```

第二台及以后的机器会显示 `joined existing network`。如果以退出码 `1` 失败并提示 `remote rejected … currently checked out`，说明传输仓库不是 bare，见[排障](#10-排障)。

告诉同伴这台机器负责什么，Big 和 Small 才能把活派给它：

```console
oguri profile update --role "构建并测试应用" --responsibility "acme/app"
```

### 3.2 检查

```console
oguri doctor
```

```text
✓ git 2.50
✓ config at /home/user/.oguri/config.yaml (1 network(s))
✓ oguri-transport → git@github.com:acme/oguri-transport.git: reachable (3/3), 0 room branch(es)
! daemon not running
  nothing accumulates while your agent is closed … start it with 'oguri daemon start'

no problems found
```

`✓` 正常，`!` 是值得读的警告，`✗` 是问题。`doctor` 还会检查策略里每个 runner 的命令是否在 `PATH` 上，以及 `worker.workdir` 是不是 Git 仓库。

### 3.3 启动 daemon

daemon 在后台和传输仓库同步，没有 agent 运行时也会把消息放进收件箱。

```console
oguri daemon start
oguri daemon status
```

```text
✓ running (pid 36413)
● running · /home/user/.oguri/daemon.sock
```

想每次登录自动启动：`oguri daemon install`（macOS 用 launchd，Linux 用 `systemd --user`）。如果 `daemon start` 说 socket 路径太长，是 `OGURI_HOME` 太深；unix socket 路径限制在 100 字节左右，请保持简短（默认的 `~/.oguri` 没问题）。

### 3.4 看板

```console
oguri web                    # http://127.0.0.1:7380，只读，仅本机回环
oguri web --port 7391        # 换端口
```

在浏览器里打开该地址，或者在 shell 里确认：`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7380/` 应打印 `200`。页面首先是 **Needs you**。同一个服务上的 `/chat` 是和 Big、Small 对话的页面（第 5 节）。想监听到回环以外要加 `--allow-remote`，并会打印一个 bearer token；不要暴露到公网。

## 4. 配置策略

一台机器能跑什么，全写在 `~/.oguri/policy.yaml`。`oguri policy --init` 会写出一份带注释的起点；`oguri policy` 打印 oguri 读到的内容及来源文件。你只管编辑，oguri 从不改写它，所以注释会保留。大多数改动在运行中的 worker 的下一轮就生效；想确保生效，就重启 `oguri superagent start` 或 `oguri worker start`。

### 4.1 最小可用配置

一台机器，一个 worker，不开 superagent。发给本机的任务用 Claude Code 执行：

```yaml
v: 1
worker:
  enabled: true
  workdir: ~/code/app # 一个 Git 仓库；每次运行得到它的一个独立 worktree
  defaultRunner: claude
  runners:
    claude:
      argv:
        [
          claude,
          -p,
          --output-format,
          json,
          --permission-mode,
          acceptEdits,
          --disallowedTools,
          "Bash(git push:*)",
        ]
      resume:
        [
          claude,
          -p,
          --output-format,
          json,
          --permission-mode,
          acceptEdits,
          --disallowedTools,
          "Bash(git push:*)",
          --resume,
          "{session}",
        ]
      session: claude-json
      worktree: true
```

验证：

```console
oguri policy
oguri doctor
```

`oguri policy` 应显示 `enabled  yes — runners: claude`；`doctor` 应显示 `worktree base … is a Git repository` 和 `'claude' is on PATH`。

### 4.2 worker 设置

| 键                            | 默认      | 含义                                                                                            |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `worker.enabled`              | `false`   | 总开关。为 `false` 时什么都不跑。                                                               |
| `worker.workdir`              | `~`       | 运行的起始目录；`worktree: true` 时是分出 worktree 的仓库。                                     |
| `worker.concurrency`          | `1`       | 同时运行数，1 到 20。另外为追问保留一个槽位。                                                   |
| `worker.maxPerHour`           | `6`       | 每个滚动小时启动的运行数，1 到 120；重启后依然有效。                                            |
| `worker.timeoutMinutes`       | `180`     | 单次运行的上限，1 到 1440。超时会结束整个进程组，然后按重试规则处理。配置里写了该值的保持原值。 |
| `worker.defaultRunner`        | 第一个    | 任务没指定时用的 runner。                                                                       |
| `worker.plannerRunner`        | 默认      | `oguri plan` 用来思考的 runner。                                                                |
| `worker.trustedRequesters`    | `[]`      | 这些 agent 的远程任务不用 `oguri task approve` 就能运行。                                       |
| `worker.onAbandon`            | `release` | 因崩溃被中断的运行：`release` 交给别的机器，或 `block` 留在本机。                               |
| `worker.retry.backoffMinutes` | `10`      | 失败后释放的任务，本机等多久才会重新接手。                                                      |
| `worker.followupDays`         | `14`      | 完成后多少天内，人的追问会让任务再跑一次。                                                      |
| `worker.maxTaskDepth`         | `2`       | 一次运行能嵌套创建子任务的深度，0 到 8。                                                        |
| `worker.capabilities`         | `[]`      | 这个 worker 声明的能力，让 `--requires gpu` 的任务能找到它。                                    |

**生效的并发数。** `worker.concurrency` 是普通 worker 的上限。小 superagent 开着时，`superagent.small.maxWorkers`（默认 3，最大 20）会取代它，因为 Small 负责决定一个请求要几个 worker。`oguri worker status` 和 `oguri superagent status` 会打印生效的值及其来源，例如 `3 at once (superagent.small.maxWorkers; worker.concurrency is 2)`。

### 4.3 Runner

runner 是一条在白名单里的命令：argv 列表，**不经过 shell**，任务正文走 stdin。任务可以用第一行 `runner: cheap` 按名字选 runner，但永远不能追加参数。

```console
oguri runner presets      # 现成的片段，附中英文注释
```

把需要的粘到 `worker.runners` 下面。像 `cheap` 这样的 preset 展示了 runner 怎么指定模型。preset 里的模型名只是**占位符**：请换成你自己的 provider 或 gateway 提供的模型。如果 `claude` 要访问 gateway 上的模型，就在 worker 运行的环境里把 `ANTHROPIC_BASE_URL`（以及你的 gateway 需要的鉴权变量）指向它。

| runner 键           | 含义                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `argv`              | 命令本身。第一个词必须在 `PATH` 上（`doctor` 会检查）。                                  |
| `model`             | 为 `claude` 加 `--model <m>`，为 `codex` 加 `-m <m>`；argv 里已有就不重复。              |
| `effort`            | 为 `claude` 加 `--effort <level>`。其他命令上写会被拒绝。                                |
| `efforts`           | 任务用 `effort:` 行能要求的、唯一允许的 effort 级别。                                    |
| `worktree`          | 在 `workdir` 的一个新 Git worktree 里运行，分支为 `oguri/<task>-<run>`。                 |
| `workdir`           | 为这个 runner 覆盖 `worker.workdir`。                                                    |
| `session`、`resume` | 怎么得到并续上会话 id：`claude-json`、`codex-jsonl`、`claude-stream`（活会话）、`file`。 |
| `oguriTools`        | 给 `claude`/`codex` 的运行提供 oguri 的工具（progress、ask、handback）。默认开。         |
| `requireResult`     | 退出码 0 却没写 `result.json` 的运行，按重试或阻塞处理，而不是算完成。                   |

**禁止 push。** 像 preset 那样，在每个 Claude worker 的 argv 里写 `--disallowedTools "Bash(git push:*)"`。worker 只靠 argv 把运行框住；agent 能做什么，由你写的 argv 决定。

### 4.4 分档位：先用便宜的，失败再升档

`worker.tiers` 把你已经列好的 runner 分成若干档，从便宜到贵。superagent 按难度选档位（默认最便宜的一档），分档任务运行失败后会被往上移一档。

```yaml
worker:
  runners:
    cheap:
      {
        argv: [claude, -p, --model, my-cheap-model, ...],
        effort: low,
        efforts: [low, medium],
        worktree: true,
      }
    standard:
      {
        argv: [claude, -p, --model, sonnet, ...],
        effort: medium,
        efforts: [low, medium, high],
        worktree: true,
      }
    strong:
      {
        argv: [codex, exec, --json, --skip-git-repo-check, "-"],
        model: example-codex-model,
        worktree: true,
      }
  tiers:
    cheap: cheap # 一档可以是一个 runner 名，
    standard: # 一个列表，
      runners: [standard] # 或带 runners 的映射
      effort: medium # 以及可选的默认 effort（必须在这档每个 runner 的 `efforts` 里）
    strong: strong
  escalation:
    maxSteps: 2 # 失败的运行最多升 2 档；0（默认）表示不升
```

解析器强制的规则：档位只能引用已存在的 runner；一个 runner 只能在一档里；最多 8 档；`escalation.maxSteps` 大于 0 时至少要有两档。任务用正文开头的头部行选择：

```text
runner: standard         # 指定 runner（指定了 runner 的任务不会升档）
tier: standard           # 或指定档位
tier-reason: touches the payment path
effort: high             # 必须在该 runner 的 `efforts` 里
```

某台机器上跑不了的档位会带着原因被拒绝，不会被悄悄换成别的 runner。`oguri worker runs` 会记录档位、原因和升档。

### 4.5 Runner 授权：每个 runner 都要有人点头

默认 `worker.runners` 里的 runner 都能跑。开启授权后，一个 runner 只有在本机终端前的人授权之后才能跑，授权绑定的是该 runner 条目当前的样子；之后再改 argv、model、effort、resume 或 workspace 相关键，授权就失效，直到重新授权。

```console
oguri runner list                                  # 每个 runner 是否已授权，谁申请过
oguri runner grant cheap --expires 7d              # 只能交互执行；会问 y/N；第一次授权就开启授权机制
oguri runner grant standard --for alice-big        # 只覆盖 alice-big 发来的任务
oguri runner revoke standard                       # worker 下一轮就生效，无需重启
oguri runner request strong "a hard refactor"      # 任何人（包括 agent）都能申请：只是申请，不授予
```

`grant` 和 `revoke` 在 worker 的运行里、以及管道里都会被拒绝，所以 Big、Small、worker 都无法给自己授权。每一次授权、撤销、拒绝和申请都会追加到 `policy.yaml` 旁边的 `runner-audit.jsonl`。授权保存在 `grants.json`（权限 `0600`），从不发布。没有授权文件就不做任何强制：机器的行为和以前一样。

当任务在等一个未授权的 runner，worker 会发一条 `needs: human` 的申请，Big 会转告你。授权立即生效。开了授权却没有任何有效授权的机器什么都不会运行，`oguri worker status` 会这么说。

### 4.6 superagent

```yaml
superagent:
  big: { enabled: true, runner: brain } # 只在一台机器上：你对话的那个 agent
  small: { enabled: true, big: alice-big, maxWorkers: 3 } # 在每台有 worker 的机器上
```

| 键                           | 默认                            | 含义                                                                  |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `big.runner`、`small.runner` | planner                         | 它思考用的 `worker.runners` 条目。请用无工具的 runner（`--tools=`）。 |
| `big.room`、`big.workRoom`   | `superagent`、`superagent-work` | 你和它们对话的房间，以及 worker 任务所在的房间。                      |
| `big.coordinate`             | `true`                          | 对 Small 的汇报采取行动，并转移没人接的 worker。                      |
| `big.githubCli`              | `gh`                            | 跟踪 worker 的 pull request，直到合并或关闭。                         |
| `small.big`                  | 无                              | Big 的 agent id。它派来的 worker 在这里不用 `oguri task approve`。    |
| `small.maxWorkers`           | `3`                             | 本机同时运行的 worker 数，1 到 20，取代 `worker.concurrency`。        |
| `small.quietMinutes`         | `30`                            | 所持任务这么久没有更新就上报。                                        |

`brain` runner（用 `oguri runner presets` 打印）带 `--tools=`，模型只判断和安排，从不动手；真正的活总是 worker 去跑的任务。

### 4.7 完整的多档位示例

下面这份按原样能被解析（已用 `oguri policy` 验证）。请替换占位的模型名和 workdir。

```yaml
v: 1
approvals:
  inboundWork: remote # 收到别的机器委派的活，先让人批准
worker:
  enabled: true
  workdir: ~/code/app
  concurrency: 2
  maxPerHour: 12
  timeoutMinutes: 180
  defaultRunner: cheap
  plannerRunner: brain
  maxTaskDepth: 2
  trustedRequesters: [alice-big]
  runners:
    brain:
      argv:
        [claude, -p, --input-format, stream-json, --output-format, stream-json, --verbose, --tools=]
      resume:
        [
          claude,
          -p,
          --input-format,
          stream-json,
          --output-format,
          stream-json,
          --verbose,
          --tools=,
          --resume,
          "{session}",
        ]
      session: claude-stream
      model: opus
      oguriTools: false
    cheap:
      argv:
        [
          claude,
          -p,
          --input-format,
          stream-json,
          --output-format,
          stream-json,
          --verbose,
          --permission-mode,
          acceptEdits,
          --allowedTools,
          "Bash(pnpm:*)",
          "Bash(node:*)",
          "Bash(git:*)",
          --disallowedTools,
          "Bash(git push:*)",
        ]
      resume:
        [
          claude,
          -p,
          --input-format,
          stream-json,
          --output-format,
          stream-json,
          --verbose,
          --permission-mode,
          acceptEdits,
          --allowedTools,
          "Bash(pnpm:*)",
          "Bash(node:*)",
          "Bash(git:*)",
          --disallowedTools,
          "Bash(git push:*)",
          --resume,
          "{session}",
        ]
      session: claude-stream
      worktree: true
      model: my-cheap-model
      effort: low
      efforts: [low, medium]
    standard:
      argv:
        [
          claude,
          -p,
          --output-format,
          json,
          --permission-mode,
          acceptEdits,
          --disallowedTools,
          "Bash(git push:*)",
        ]
      resume:
        [
          claude,
          -p,
          --output-format,
          json,
          --permission-mode,
          acceptEdits,
          --disallowedTools,
          "Bash(git push:*)",
          --resume,
          "{session}",
        ]
      session: claude-json
      worktree: true
      model: sonnet
      effort: medium
      efforts: [low, medium, high]
    strong:
      argv: [codex, exec, --json, --skip-git-repo-check, "-"]
      resume: [codex, exec, --json, resume, "{session}", "-"]
      session: codex-jsonl
      worktree: true
      model: example-codex-model
  tiers:
    cheap: cheap
    standard: { runners: [standard], effort: medium }
    strong: strong
  escalation: { maxSteps: 2 }
superagent:
  big: { enabled: true, runner: brain }
  small: { enabled: true, big: alice-big, maxWorkers: 3 }
```

`oguri policy` 会打印 `3 at once (superagent.small.maxWorkers; worker.concurrency is 2)`、`12/hour`、`180 min` 和 `trusted alice-big`。

## 5. 和 superagent 对话

启动本机策略里打开的角色：

```console
oguri superagent start &          # big 和/或 small，连同本机的 worker
oguri superagent status
```

```text
superagent
  big         on  room superagent · workers in superagent-work · coordinate on
  small       on  · trusts alice-big
  concurrency 3 at once (superagent.small.maxWorkers)
  deployed    0 worker(s) followed
  running     0 worker(s) on this machine
  today       0 worker run(s)
  cost scope  worker runs only; excludes Big/Small superagent brain sessions
```

| 角色   | 在哪里运行   | 做什么                                                                                 |
| ------ | ------------ | -------------------------------------------------------------------------------------- |
| Big    | 一台机器     | 你唯一的联系人。规划、在任意机器上派 worker、转达你的话、移动或停止 worker、回答问题。 |
| Small  | 每台机器     | 决定一个请求在本机要几个 worker，最多 `maxWorkers` 个；汇报沉默或卡住的；直接回答你。  |
| Worker | 每个任务一个 | 在自己的 worktree 里跑 Claude Code 或 Codex。汇报进展、提问、把超出任务的活交回去。    |

模型的每个决定都由代码检查。决定里出现它没被展示过的机器、任务、房间或能力，越权的角色，依赖环，或密钥，都会被拒绝，什么也不会启动。

### 怎么对话

```console
oguri big "给设置页加一个深色模式开关"          # 等第一条回复
oguri big "还有 Cancel 按钮" --detach           # 回复会出现在：oguri read superagent
oguri small machine:gpu-box "基准测试跑得怎么样了？"
oguri chat                                      # 终端里的连续对话
oguri chat --target machine:gpu-box             # 和某台机器的 Small 对话
```

`oguri chat` 里可用：`/targets`、`/target <名字>`、`/history`、`/help`、`/exit`。`oguri web` 运行时，同样的对话在 `http://127.0.0.1:7380/chat?target=big`。如果没人回复，先确认 `oguri superagent start` 在运行：消息会在传输仓库里等着它。

### 直接派活

任务就是普通消息，你可以绕过 Big，自己把任务放到某台机器上。正文开头的头部行决定怎么跑：

```console
oguri task create ops "runner: standard
tier-reason: touches billing
effort: high

Add idempotency keys to the refund client." --machine gpu-box --title "Refund idempotency"
```

### 查看进度

| 想看           | 运行                                                     |
| -------------- | -------------------------------------------------------- |
| 谁在做什么     | `oguri superagent status` · `oguri team` · `oguri web`   |
| 本机的 worker  | `oguri worker status`（策略、本小时剩余额度、在跑的）    |
| 最近的本地运行 | `oguri worker runs --limit 20`                           |
| 一个任务的全部 | `oguri task show <room> <id>`                            |
| 一个房间的任务 | `oguri task list <room>` · `oguri task tree <room> <id>` |
| 原始对话       | `oguri read superagent`                                  |

**费用与模型证据。** `oguri superagent status` 把今天的费用标成**已知小计**，并说明有多少次运行不在其中，因为有些 runner 不打印价格。它只统计 worker 运行，不含 Big 和 Small 的 brain 会话；从不把一次运行按 $0 计。看板的 **Runs & cost** 页按来源分别显示每次运行的模型证据：argv 里请求的、CLI 启动时报告的、回答 usage 里报告的。这些只是标签，不证明是哪个权重在回答，gateway 也可能改写模型名，请据此判断。每次运行的 `run.json`（在 `~/.oguri/runs/<task>/<run>/`）记录档位、档位原因、effort 及其来源、升档，以及被回收的后台进程数。

## 6. 加第二台机器

在新机器上先安装（第 2 节），然后用**不同的** agent 名加入**同一个**传输仓库：

```console
oguri init --repo git@github.com:acme/oguri-transport.git --agent gpu-box
oguri daemon start
oguri doctor
```

`init` 会显示 `joined existing network`。写这台机器自己的策略：它自己的 worker 和 runner，以及指向 Big 的 Small。它**不需要**自己的 Big。

```yaml
v: 1
worker:
  enabled: true
  workdir: ~/code/bench
  capabilities: [gpu]
  runners:
    claude:
      argv:
        [
          claude,
          -p,
          --output-format,
          json,
          --permission-mode,
          acceptEdits,
          --disallowedTools,
          "Bash(git push:*)",
        ]
      resume:
        [
          claude,
          -p,
          --output-format,
          json,
          --permission-mode,
          acceptEdits,
          --disallowedTools,
          "Bash(git push:*)",
          --resume,
          "{session}",
        ]
      session: claude-json
      worktree: true
superagent:
  small: { enabled: true, big: alice-mac, maxWorkers: 2 } # alice-mac 是 Big 所在 agent 的 id
```

```console
oguri superagent start &
oguri team
```

`oguri team` 在一屏里列出每台机器、每个 agent 和能力，以及本机的 runner 和并发数。一分钟内第一台机器应当能看到 `gpu-box`。此后 `oguri big` 可以把活派到任意一台，你也可以直接指名某台机器：`oguri small machine:gpu-box "…"` 或 `oguri task create ops "…" --machine gpu-box`。

**委派的活先要批准。** 默认 `approvals.inboundWork: remote` 下，来自别的机器的任务要在接收机器上 `oguri task approve <room> <id>` 才会开始，除非请求者在 `worker.trustedRequesters` 里，或就是 `small.big` 指定的 Big。

**机器离线时会怎样。** 消息和任务都留在传输仓库里，不会丢，也不会卡住别人：Big 看到该机器不再汇报，开了 `coordinate` 时会把 30 分钟没人接的任务移到另一台。机器回来后同步、找到自己的任务；被中断的运行按 `onAbandon` 处理，默认 `release` 交给别的机器，或 `block` 留给你看。执行 `oguri worker install` 和 `oguri daemon install`，重启后它会自己回来。

## 7. 日常运维

**需要你处理的。** `oguri web` 首页就是 **Needs you**。在 shell 里：

```console
oguri inbox                                   # 待处理的消息
oguri task agenda --mine                      # 跨房间的未完成工作
oguri task approve <room> <id>                # 让一个委派来的任务开始
oguri answer <message-id> "用 10k 的样本。" --as-human   # 回答 needs-human 的问题；会问 y/N
```

`needs: human` 是协作性的：agent 清不掉它，但 `--as-human` 不能证明当时是谁坐在键盘前。

**追问、续跑、取消。** 在任务的线程里说话（`oguri big "用 10k 的样本"` 或在线程里发一条消息），worker 会在同一目录里续上同一个会话，完成后 `followupDays` 天内都有效。活会话 runner（`session: claude-stream`）运行中就能听到。用 `oguri big "停掉压测"` 停止工作；如果任务是你创建的，也可以 `oguri task update <room> <id> cancelled "原因"`。

**东西在哪。**

| 内容            | 位置                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| 配置            | `~/.oguri/config.yaml`（oguri 会改写）、`~/.oguri/policy.yaml`（你的）               |
| daemon 日志     | `~/.oguri/logs/daemon.log`                                                           |
| 一次运行的文件  | `~/.oguri/runs/<task>/<run>/`：`stdout.log`、`stderr.log`、`run.json`、`result.json` |
| superagent 会话 | `~/.oguri/superagent/*-session.json`                                                 |
| 授权与审计      | `~/.oguri/grants.json`、`~/.oguri/runner-audit.jsonl`                                |
| 缓存            | `~/.oguri/state.db`（可随时删除；从 Git 重建）                                       |

**备份。** 只有 `policy.yaml` 是你独有、又无法推导的文件：拷走它。其余一切的记录都在传输仓库里，克隆一份就是完整备份；`config.yaml` 可以用 `oguri init` 重建。不用备份 `state.db`。

**升级。** `npm i -g oguri@latest`（或重装二进制），然后重启正在运行的进程：`oguri daemon stop && oguri daemon start`，以及 `oguri superagent start` / `oguri worker start`。之后运行 `oguri doctor`。worker 停止时仍在进行的运行，会在下次启动时被发现并按 `onAbandon` 处理。

## 8. 从 1.0.1 升级

你的 `policy.yaml`、`config.yaml` 和传输仓库都继续有效：1.0.1 的每个键依然能解析，所有新键都是可选的。步骤：

1. `npm i -g oguri@1.0.5`，然后 `oguri --version`。
2. 重启 daemon 以及 superagent 或 worker 进程（`oguri daemon stop && oguri daemon start`）。
3. `oguri doctor` 和 `oguri policy` 应读出同样的策略。
4. 除非你主动选用，其他都不变。新增且值得一读的：
   - **默认单次运行上限现在是 180 分钟**（原为 60）。写了 `timeoutMinutes` 的配置保持原值。
   - `worker.tiers` 和 `worker.escalation`（4.4 节）、runner 授权（4.5 节）、`worker.maxTaskDepth`。
   - worker 的一次运行现在只能写它自己的任务及其子任务。
   - 任务按优先级领取，同优先级内先到先得。
   - `oguri chat`、`/chat` 页面和重新设计的看板。
   - 退出码 0 却没有 `result.json` 的运行现在会如实说明；`requireResult: true` 让它改为重试。
5. 在第一次 `oguri runner grant` 之前，授权一直是**关闭**的，所以升级不会让任何东西停摆。

新旧混用的机器群可以工作：老机器和新机器通过同一个传输仓库交换消息。老客户端会拒绝新的 `relinked` 任务动作，而不是误读它，所以在使用 `oguri task update … relinked` 之前，请先把每台机器都升级。

## 9. 安全模型

- **仓库访问就是边界。** 只有能 push 到传输仓库的机器才参与。
- **机器的主人说了算。** worker、superagent、intake 和通知都在本机的 `policy.yaml` 里配置。没有任何消息能改它，oguri 也从不写它。
- **入站审批。** `approvals.inboundWork: remote`（默认）要求有人批准别的机器委派的活。`never` 是完全自主；`always` 是所有都问。
- **命令白名单，不经 shell。** runner 是 argv 列表。任务只能按名字在 runner 之间选择，永远不能追加参数；任务正文通过 stdin 交给 agent。
- **Runner 授权。** 开启授权后，runner 只有在一个明确的、可撤销的、有审计的、并绑定到当前写法的人工授权下才能运行。
- **被框住。** 并发上限、每小时上限、结束整个进程组的超时，以及 worker 只能写自己的任务。请在 argv 里禁止 `git push`。
- **密钥不进历史。** 消息、运行摘要、推送和聊天回复都会经过密钥扫描，扫描器会拒绝并且从不回显具体值。
- **聊天 intake** 只接受名单里的人在名单里的聊天中发出的请求，由代码判定。

连接敏感仓库之前，请先读 [SECURITY.md](../../SECURITY.md)。

## 10. 排障

先运行 `oguri doctor`；它会检查 Git、配置、传输仓库、worktree、每个 runner 的命令和 superagent 的会话文件。

| 现象                                                                 | 原因与处理                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `! [remote rejected] main -> main (branch is currently checked out)` | 传输仓库不是 bare。`git clone --bare <repo> <transport>.git`，然后重新 `oguri init`。                                                       |
| `oguri init` 卡住或说远程不可达                                      | 用本机同样的凭据跑 `git ls-remote <url>`；SSH 密钥或 token 必须不用提示就能工作。                                                           |
| `timed out … waiting for …/lock (held by pid …)`                     | 另一个 oguri 进程持有网络锁。如果那个进程已经不在了，删掉提示里的锁文件。                                                                   |
| `oguri is not configured`                                            | 这台机器还没有网络，或 `OGURI_HOME` 不对。运行 `oguri init`。                                                                               |
| `daemon did not come up within 4s`                                   | 看 `~/.oguri/logs/daemon.log`。`OGURI_HOME` 太长也会这样：socket 路径必须在约 100 字节以内。                                                |
| `oguri big` 说 no reply yet                                          | Big 的 `oguri superagent start` 没在运行，或 Big 的 runner 失败了。在终端里运行它并看输出；`oguri doctor` 会检查 runner 的命令。            |
| `runner 'claude': 'claude' not on PATH`                              | worker 的环境里没有它。登录服务的 `PATH` 比你的 shell 短：在 `argv` 里写绝对路径，或从有它的 shell 里启动 worker。                          |
| 任务停在 worker 那里，什么也不跑                                     | 要么远程任务在等 `oguri task approve`，要么某个 runner 在等授权（`oguri runner list`），要么 `maxPerHour` 用完了（`oguri worker status`）。 |
| `✗ runner grant refused`                                             | 设计如此：只有坐在交互终端前的人才能授权。请自己执行，不要在脚本或运行里执行。                                                              |
| 一次运行在上限处被杀                                                 | 超过了 `worker.timeoutMinutes`（默认 180）。调大（最多 1440）或拆分任务。任务会按 `worker.retry` 重试或阻塞。                               |
| `worker runs` 里的模型不是你要的那个                                 | 模型证据只是标签。gateway 可能改写名字，请去查 gateway。`oguri worker runs` 和看板把请求的与 CLI 报告的分开显示。                           |
| 并发数和 `worker.concurrency` 不同                                   | 小 superagent 开着，生效的是 `superagent.small.maxWorkers`。`oguri worker status` 两个都会显示。                                            |
| 每条命令都报 `unknown key 'worker.…'`                                | `policy.yaml` 里有笔误。解析器拒绝不认识的键；错误信息会指出键名并列出合法的键。                                                            |
| 消息发出去了，没人看到                                               | 用 `oguri status` 看排队的；远程不可达时发送会悄悄排队。                                                                                    |

## 11. 不用付费模型验证整条链路

可以用一个不调用任何模型、只写结果的替身 runner，端到端验证一次部署。请用一个临时的 home，免得碰到真实的那个。

```console
export OGURI_HOME=/tmp/oguri-try           # 保持简短；socket 路径有长度限制
git init --bare /tmp/oguri-try-transport.git
git init -b main /tmp/oguri-try-app && git -C /tmp/oguri-try-app commit --allow-empty -m init

cat > /tmp/fake-runner.mjs <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const task = readFileSync(0, "utf8");
writeFileSync(process.env.OGURI_RESULT_FILE, JSON.stringify({ summary: "handled: " + task.slice(0, 40) }));
EOF

oguri init --repo /tmp/oguri-try-transport.git --agent trial-alice
oguri room create ops --title Operations
cat > $OGURI_HOME/policy.yaml <<EOF
v: 1
worker:
  enabled: true
  workdir: /tmp/oguri-try-app
  timeoutMinutes: 5
  runners:
    fake: { argv: ["$(command -v node)", "/tmp/fake-runner.mjs"], worktree: true }
EOF
oguri task create ops "say hello" --title "Try it" --target trial-alice
oguri worker start --once        # 'completed after 0s'
oguri task list ops              # 任务显示 'completed'
```

之后 `oguri worker runs` 会显示这次运行，`oguri web --port 7391` 应返回 `200`。用完删掉 `/tmp/oguri-try*`。
