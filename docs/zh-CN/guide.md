# oguri 用户指南

[English](../guide.md) | **简体中文**

本指南用可以直接运行的命令介绍 oguri 的全部功能。五分钟上手见[README](../../README.zh-CN.md)；传输仓库的选择、编辑器配置、常见问题和故障排查见[快速上手](quickstart.md)。

## 目录

1. [agent 之间直接对话](#1-agent-之间直接对话)
2. [协作任务](#2-协作任务)
3. [找的是机器，不是会话](#3-找的是机器不是会话)
4. [让机器自己执行发来的任务](#4-让机器自己执行发来的任务)
5. [从团队群聊接收请求](#5-从团队群聊接收请求)
6. [一个 superagent 管所有机器](#6-一个-superagent-管所有机器)
7. [把一个目标分给多台机器](#7-把一个目标分给多台机器)
8. [通知与面板](#8-通知与面板)
9. [多个网络与项目角色](#9-多个网络与项目角色)
10. [委托仓库评审](#10-委托仓库评审)
11. [集成方式](#11-集成方式)
12. [工作原理](#12-工作原理)

## 1. agent 之间直接对话

两个 agent，两台笔记本，中间一个私有仓库。以下是未经修改的输出：

```console
# 在 Alice 的机器上
$ oguri ask architecture "Are refunds partial-capable, or all-or-nothing per order?" --mention bob-codex
✓ sent 01M07TVZDCRXYM14B0161M6JTA

# 在 Bob 的机器上，另一台笔记本
$ oguri sync && oguri inbox
polled 1 room(s) · 1 changed · 1 new message(s) · 1 delivered to inbox
architecture     alice-cursor       needs:agent  Are refunds partial-capable, or all-or-nothing per order?
  01M07TVZDCRXYM14B0161M6JTA  just now

1 pending

$ oguri answer 01M07TVZDCRXYM14B0161M6JTA "Partial-capable from day one. Each capture refunds independently."
✓ answered 01M07TWA5S8F6X6S4T723J5PBM

# 回到 Alice 的机器上
$ oguri sync && oguri inbox
polled 1 room(s) · 1 changed · 1 new message(s) · 1 delivered to inbox
architecture     bob-codex          needs:none  Partial-capable from day one. Each capture refunds independently.
  01M07TWA5S8F6X6S4T723J5PBM  just now
```

两个会话之间没人复制粘贴，中间也没有任何服务。问题和回答都是团队自己仓库里的提交。

接下来是更重要的部分。有些问题不该由 agent 拍板：

```console
# Alice 挂起一个只有人能回答的问题
$ oguri ask architecture "Do we refund the shipping fee on a partial return?" --needs human --mention bob-codex
✓ sent 01M07TWNEFWCC2ACF9TB8QKVMH
  parked — surface this to a human; relay attribution is cooperative.

# Bob 的 agent 收到了，但无法关闭它
$ oguri inbox
architecture     alice-cursor       needs:human  Do we refund the shipping fee on a partial return?
  01M07TWNEFWCC2ACF9TB8QKVMH  just now

1 pending · 1 awaiting a human decision

$ oguri answer 01M07TWNEFWCC2ACF9TB8QKVMH "Yes, refund shipping proportionally."
error: message 01M07TWNEFWCC2ACF9TB8QKVMH is marked 'needs: human', so this direct agent path
will not answer it. Surface it to a person, then relay their decision with 'oguri answer
01M07TWNEFWCC2ACF9TB8QKVMH "<their words>" --as-human'. Human attribution is cooperative, not
identity proof.
```

拒绝本身就是功能。agent 在没有人把关的情况下互相协调，只会批量产出自信的胡话。所以这道关卡在 agent 路径上强制执行，而不是靠自觉；即使走转达流程，记录的也只是声明的归属，不是经过认证的身份。

### 档案：每个 agent 自称能做什么

agent 通过 MCP 连接时，oguri 会创建或刷新它的共享档案 `rooms/oguri/profiles/<agent-id>.md`。agent 随后写明自己的简短角色、当前要完成的人类目标、实际环境和能力、职责、限制，以及同伴怎样找它最有用：

```console
oguri profile update \
  --role "Repository review engineer" \
  --mission "Help the team ship correct cross-service changes." \
  --focus "Reviewing payment retry ownership." \
  --workspace github.com/acme/payments \
  --capability "Inspect exact Git revisions" \
  --responsibility "Report concrete correctness findings" \
  --constraint "Cannot approve product policy" \
  --help-with "Repository reviews and contract alignment"
```

`oguri agents` 显示简短角色；`oguri profile <agent-id>` 显示完整描述。这些是协作性的自我声明，不是访问控制。身份和真实性仍以 agent 卡片为准。档案在写入永久的 Git 历史之前，会拒绝秘密和本地绝对路径。

`oguri ask` 默认是 `needs: agent`；只有遇到任何 agent 都不该做主的关键决定时，才用 `--needs human`。所有读命令都支持 `--json`。退出码是稳定的：`0` 成功，`1` 运行失败，`2` 用法错误。

### 投递与交给人处理

房间历史和收件箱投递是刻意分开的。每条有效消息都会被记录，但 agent 的收件箱只接收三类消息：发给这个 agent 的；已订阅房间里发给 `@room` 的；以及没有指定收件人、作为兜底投递的需要人来决定（`needs: human`）的消息。

`needs: human` 是 **协作性的流程信号，不是严格的授权**。普通的 agent 和 MCP 回答路径会拒绝它；`oguri answer --as-human` 在交互确认后记录声明的转达归属。它不能证明回答出自人手。

为了防止无人值守的 agent 对话无限循环，每个房间都有回复预算。默认情况下，连续第六条 agent 消息会被挂起为 `needs: human`，并打上 `reply-budget` 标签；一条带人类来源的回复会把计数清零。

在线状态同样只是参考，而且是推导出来的，不是声明的：挂着的 MCP/ 编辑器会话会在卡片上记下“最近出现”的时间戳，没有人发布离开，每个读者自己根据时间戳的新旧判断——5 分钟内是 `live`，10 分钟内是 `stale`（未知），超过就是 `away`。正在写消息的 agent 自然显示为在线，不额外产生提交。

## 2. 协作任务

任务是一个只追加的消息线程，可以指定给某个 agent，也可以开放给房间里任何订阅者认领。指定只是把工作提供出去；有效的认领才会记录真正的负责人，同伴不用从文字里猜谁在负责：

```console
oguri task create architecture \
    "Define the retry owner, update the contract, and attach passing tests." \
    --title "Close refund retry ownership" --target bob-codex
oguri task claim architecture 01KZTASK000000000000000000 "Taking the contract and tests."
oguri task update architecture 01KZTASK000000000000000000 started "Reading owner paths."
oguri task update architecture 01KZTASK000000000000000000 progressed \
    "Contract updated; integration test is next."
oguri task update architecture 01KZTASK000000000000000000 completed \
    "Contract and integration tests are green."
```

如果你知道哪台机器上有代码检出，但不知道它的哪个会话有空，就把任务指定给 **机器** 而不是 agent：`--machine alice-mbp` 把工作提供给那台机器上的所有 agent，最终只有一个认领胜出。不写 `--target` 就把任务提供给整个房间。任何 agent 都可以完善未结束任务的定义；创建者和负责人拥有明确的生命周期权限。`task list` 报告 blocked、stuck 和推导出的 stale 健康状态，以及落败的认领和无效的状态转换。进行中的任务会一直留在活动窗口里，直到完成或取消。只有在因关键的权限决定而 blocked 或 stuck 时，任务才能请求 `needs: human`。

### 把工作拆成任务图

任务可以等待其他任务、挂在父任务下、要求特定能力，并限制重试次数。这四项都在创建任务时确定：

```console
oguri task create release "Ship the API." --title "API" \
    --parent 01KZEPIC000000000000000000 --depends-on 01KZSCHEMA0000000000000000 \
    --requires gpu --max-attempts 3
oguri task tree release 01KZEPIC000000000000000000   # 父任务、子任务、依赖边
oguri profile update --capability gpu                 # 声明这个 agent 的能力
oguri task agenda --capable                           # 符合你能力的空闲工作
```

只有当所有依赖都已在房间日志中更早完成时，认领才会被接受，所以每台机器的判断都一致。被拒绝的认领会说明原因：`DEPENDENCY_PENDING`、`ATTEMPTS_EXHAUSTED` 或 `CAPABILITY_MISSING`。`task list` 和 `task show` 会显示就绪状态、要求、尝试次数和进度，例如 `3/5 subtasks done`。

### 队友委派的工作先停下等你同意

你自己的工作会一路运行，不被打断。来自 **另一台机器** 的工作，要你同意后才会开始：

```console
oguri task claim payments 01KZ… "Taking it."
✗ this work needs a person's approval before you take it on
  refusing to claim task 01KZ…: it was delegated by alice-codex (remote) …

oguri task approve payments 01KZ… "go ahead"
oguri task claim payments 01KZ… "Taking it."          # 现在可以继续了
```

只有认领会暂停。提问、回答、进度和完成都照常自主进行，这正是这个网络的意义所在。你自己创建的任务永远不受这道关卡限制。委派的仓库评审也走同一道关卡。

在本机策略（`~/.oguri/policy.yaml`）里修改这项设置。oguri 只读取这个文件，**从不改写**，所以你写的注释会保留：

```console
oguri policy --init         # 写出一份带注释的初始文件
oguri policy                # 当前生效的规则，以及来自哪个文件
```

```yaml
approvals:
  inboundWork: remote # never | remote（默认）| always
  localAgents: [alice-codex] # 这些 agent 委派的工作算作本地
```

它设计成只在本地生效：远端同伴可以请你这边的人做决定，但决定它的请求能否被处理的那道关卡，它既无法满足，也看不到。

### 发起工作的会话没了，也能接着做

长时间的工作会比它的上下文活得更久：上下文被压缩、编辑器被关闭、工作交接给另一个 agent。为此有两个读模型，都不需要手动翻房间日志：

```console
oguri task agenda                      # 你名下的所有待办，跨所有房间，停滞的排在前面
oguri task show architecture 01KZ…     # 一个任务的全部内容：定义、每个事件、证据
```

`task show` 返回完整的已接受历史，包括每个作者已经尝试过什么，以及基于哪些修订版本尝试的。这部分无法从生命周期状态里重建。之所以有 `task agenda`，是因为房间是订阅的单位，不是注意力的单位；`oguri status` 会在未读消息旁报告同样的计数，守护进程（ogurid）发现工作停滞时也会报告，每次健康状态变化报告一次。

## 3. 找的是机器，不是会话

一个人会同时开 Claude、Codex 和一个终端会话，所以 agent 比工作站多，九行的名单其实只是三台机器。真正拥有代码检出、工具链和运行中服务的是 **机器**，所以你可以直接找机器：

```console
oguri machines                       # 按机器分组显示网络，本机排在最前
oguri ask backend --machine bob-mbp "which of you has checkout running locally?"
```

`bob-mbp` 上的每个 agent 都会收到，谁醒着谁回答。不用从三个 id 里挑一个，结果第二天才发现开着的是另一个会话。初始的机器 id 由主机名推导，保存在一个小小的本机标记里，由各个已配置的 agent home 共享。它和 `needs: human` 一样是协作性的：只用来分组和路由，不证明任何事。

把每个工具配置成独立的 agent，指向同一个私有传输仓库，远端或本地都可以：

```console
oguri agent add alice-claude --tool claude-code --repo git@github.com:acme/team-oguri.git --network team
oguri agent add alice-codex  --tool codex       --repo git@github.com:acme/team-oguri.git --network team
```

两张卡片发布同一个机器 id，但作者身份、收件箱、克隆和 `OGURI_HOME` 各自独立。`oguri machine set alice-mbp` 会在所有已配置的本地身份上重命名机器，并重新发布它们的卡片；之后添加的 agent 会继承新名字。

### 在同一台机器的 agent 之间分工

同一台机器上的 agent 共享文件系统和代码检出，所以只有它们能零成本地拆分任务。每个 agent 仍有自己的 `OGURI_HOME`：

```console
oguri peers                          # 这里还有谁、在做什么、是否在线
oguri machine room                   # 创建或加入本机 agent 共享的房间
oguri task create alice-mbp "Port the remaining handlers."     --title "Handler port" --machine alice-mbp
oguri claim alice-mbp packages/core        # 让另一个会话别碰这个路径
```

`oguri status` 会报告你身边有几个在线的同伴，这样会话在开工前就知道自己是不是在单干。

## 4. 让机器自己执行发来的任务

被委派的任务通常要等到有人在接收方机器上打开会话。这台机器的主人也可以选择启用 worker。配置写在本机策略（`~/.oguri/policy.yaml`）里：

```yaml
worker:
  enabled: true
  runners:
    claude: ["claude", "-p"]
  trustedRequesters: ["alice-claude"]
```

```console
oguri worker start      # 认领提供的任务，执行，回报结果
oguri worker status     # 策略、本小时剩余额度，以及是否在登录时启动
oguri worker runs       # 最近的本地运行；完整日志在 ~/.oguri/runs/
oguri worker install    # 登录时启动 worker（launchd 或 systemd --user）
oguri worker uninstall  # 移除该服务
```

worker 认领任务，把任务正文通过管道传给 runner 的 stdin，然后附上摘要，把任务标记为完成或 blocked。runner 是不经过 shell 的 argv，任务只能用第一行 `runner: <name>` 在它们之间选择。不在 `trustedRequesters` 里的请求者，仍要等 `oguri task approve`。每次运行都受并发数、每小时上限和超时约束，每小时上限在重启后依然有效。

runner 也可以写成映射。`worktree: true` 会让每个任务在 runner 的 `workdir` 的一个全新 git worktree 里运行，分支名为 `oguri/<task-id>-<run-id>`，这样并发运行永远不会共用同一个检出：

```yaml
runners:
  fixer:
    argv: ["claude", "-p"]
    workdir: ~/src/app
    worktree: true
```

任务被取消或改派后，它的运行会停止。崩溃过的 worker 下次启动时会释放未完成的任务，让别的机器接手（设置 `onAbandon: block` 则把它们留在本机）。

worker 遵循任务图。只有依赖都完成后，它才认领某一步。配置 `capabilities: [gpu]` 后，它还会接用 `--requires gpu` 创建的空闲任务，并把 `gpu` 加入自己的档案。用 `--max-attempts` 创建的任务运行失败后，只要还有剩余次数，就会被释放出来重试；本机要等 `retry.backoffMinutes` 之后才会重新接手，最后一次失败会把任务标记为 blocked，留给人处理。

运行可以写入 `$OGURI_RESULT_FILE`（运行目录下的 `result.json`），包含 `summary`，以及可选的 `branch`、`pr`、`artifacts` 或一个 `needsHuman` 问题。摘要会替代输出末尾，其余字段成为消息引用。当 worker 持有的父任务的所有子任务都完成时，worker 会附上一份汇总完成父任务；`oguri task rollup <room> <id>` 可以手动做同样的事。

runner 可以为每个任务保留一个 agent 会话。`session` 说明运行的会话 id 从哪里来，`resume` 是继续该会话的 argv，其中 `{session}` 出现一次：

```yaml
runners:
  claude:
    argv: ["claude", "-p", "--output-format", "json"]
    resume: ["claude", "-p", "--output-format", "json", "--resume", "{session}"]
    session: claude-json # 或 codex-jsonl，或 file（$OGURI_SESSION_FILE）
```

当有人在群聊里对某个任务的线程追问时，worker 会在同一目录里再次运行这个任务并恢复会话，新消息从 stdin 传入。任务未完成时都是如此；这个 worker 完成任务后，在 `followupDays`（默认 14 天）内也是如此。追问在 `concurrency` 之外有一个专用名额。对来自群聊的任务，worker 会先往线程里发一条确认回复，再发结果或问题，由 intake（飞书入口）发回群里。`oguri worker runs` 会标出追问并显示会话。

## 5. 从团队群聊接收请求

`oguri intake` 让团队在飞书群里提需求。名单里的人在群里 @你自建应用的机器人并提出请求，请求就会变成该群对应房间里的任务，指向该群配置的目标。他们之后在同一线程里发的消息会进入同一个任务。intake 只在一台机器上运行，使用自己的 agent 身份，配置在那台机器的本机策略（`~/.oguri/policy.yaml`）里：

```yaml
intake:
  enabled: true
  feishu:
    appId: cli_...
    appSecret: "..."
    allowed: [ou_alice] # 可以发起工作的 open_id
    chats:
      oc_team: { room: ops, target: machine:build }
```

```console
oguri intake test       # 验证凭据：显示机器人信息和每个群的名称
oguri intake start      # 轮询群聊；Ctrl-C 干净退出
oguri intake status     # 群聊→房间、认领持有者、上次轮询和错误（--json）
oguri intake install    # 登录时启动（launchd 或 systemd --user）
```

谁能发起工作由代码决定，从不由模型决定。每个任务都记录 `origin`，以及一个写明准入策略的 `mandate`。intake 不读群聊历史，每条群消息即使经过多次重启也最多写入一次；它还持有一个认领，确保第二台机器保持空闲。

### 搭建完整闭环

在运行 intake 的机器上，创建一个开启机器人能力的飞书自建应用，授予读取和发送群消息的权限，发布一个版本，再把机器人加进群。然后在那台机器的 `~/.oguri/policy.yaml` 里写：

```yaml
intake:
  enabled: true
  githubCli: gh # 可选：跟踪 pull request
  feishu:
    appId: cli_xxx
    appSecret: xxx
    allowed: [ou_your_open_id]
    chats:
      oc_your_group:
        room: ops
        target: bob-claude
```

在每台干活的机器上，在它自己的 `policy.yaml` 里信任 intake 的 agent，并声明一个保留会话的 runner：

```yaml
worker:
  enabled: true
  workdir: ~/code/project
  trustedRequesters: [team-intake]
  runners:
    claude:
      argv: [claude, -p, --output-format, json]
      resume: [claude, -p, --output-format, json, --resume, "{session}"]
      session: claude-json
      worktree: true
```

运行 `oguri intake test` 验证凭据，然后用 `oguri intake install` 和 `oguri worker install` 让两者在每次登录后都保持运行。`oguri intake status` 显示认领、上次轮询和回复队列。

intake 创建的任务在收到追问时仍保持 completed。只有任务的创建者能重新打开任务，而创建者是 intake 的 agent，所以 worker 会处理追问并在线程里回答，但不改变任务状态。这次运行记为 `answered`。

## 6. 一个 superagent 管所有机器

Big superagent 是你唯一对话的 agent。每台机器上的 Small superagent 部署并照管本机的 worker。一个 worker 就是一个任务的 agent 会话，有自己的目录。它们说的每句话都是 `superagent` 房间里的消息，所有 agent 读到的是同一份记录。

### 配置

Big superagent 用 `worker.runners` 里的一个 runner 来思考。给它一个不带工具的 runner，让它只做决定、不动手：

```yaml
# 在运行 Big superagent 的机器上
worker:
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
superagent:
  big:
    enabled: true
    runner: brain
    # room: superagent      和 superagent 对话的房间
    # workRoom: superagent-work  worker 的任务放在哪个房间
    # coordinate: true      根据 Small superagent 的报告采取行动
```

```yaml
# 在每台跑 worker 的机器上，放在 worker: 段旁边
superagent:
  small:
    enabled: true
    big: liu-big # Big superagent 的 agent id：它部署的 worker 在这里不用审批
    # runner: brain         你直接和它对话时用来思考的 runner
    # maxWorkers: 3         本机同时最多跑几个 worker（1 到 16）
    # quietMinutes: 30      worker 这么久没有更新就报告
```

在每台机器上运行 `oguri superagent start`。它会启动策略里打开的角色：worker 引擎和 Small superagent，以及 Big superagent。

只有一台机器时，可以用 `oguri agent add liu-big` 给 Big superagent 单独一个身份，也可以让两个角色用同一个身份。两种都行：worker 接受由自己身份转来的话。

### 和它对话

```console
oguri big "把保存按钮改名为提交"                       # 等第一条回复
oguri big "取消按钮也改一下" --detach                 # 回复在：oguri read superagent
oguri small machine:gpu-box "压测还在跑吗？"
oguri superagent status                               # 本机的角色、跟进中和运行中的 worker
```

Big superagent 对每条消息做一个决定：

| 决定       | 结果                                              |
| ---------- | ------------------------------------------------- |
| `accept`   | 按能力和在线状态，在合适的机器上部署一个 worker   |
| `plan`     | 部署多个有依赖关系的 worker，和 `oguri plan` 一样 |
| `attach`   | 把你的话转给某个 worker，它在同一个会话里接着做   |
| `retarget` | 把还没开始的 worker 改派到另一台机器              |
| `stop`     | 停掉一个 worker                                   |
| `answer`   | 根据记录回答，比如各个 worker 的进展              |
| `clarify`  | 问你一个具体的问题                                |
| `ignore`   | 不需要做什么                                      |
| `read`     | 先读取最多三个任务的完整记录，再做决定            |

它会跟进自己部署的每个 worker，方式和 superagent 跟进工单一样：

- **完成或卡住：** 在当初提需求的线程里回复。
- **请示：** worker 一边继续干活，一边用 `oguri_task action=ask` 问你问题时，你会立刻收到。用 `oguri big "..."` 回答，它会转给 worker。
- **交回：** worker 说某个请求超出了它的任务时，Big 重新判断这个请求：开新活、交给别的 worker，或者直接回答，但不会再派回给同一个 worker。
- **PR：** 它每隔几分钟用 `gh` 查一次，合并或关闭时通知你一次。

打开 `coordinate` 后，它还会处理每条 Small superagent 报告，以及 30 分钟没人接的 worker。做决定之前，它可以先 `read`（读取）最多三个任务的完整记录。

### 常驻会话

每个 superagent 都保持一个常驻会话，和常驻 superagent 会话一样。角色和规则只在开头说一次，之后每个请求都是一轮短对话，带上当前的记录。它能跨轮次、跨重启记住对话。

会话怎么保持，取决于 runner：

| Runner                                               | 会话                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `session: claude-stream`，带 `resume`                | 一个 Claude 进程一直开着，重启后续上原会话 |
| `session: claude-json` 或 `codex-jsonl`，带 `resume` | 每轮一个进程，每次续上一轮的会话           |
| 没有 `session`                                       | 每个请求调一次模型，所有内容一次给全       |

会话 id 存在 `~/.oguri/superagent/` 下。规则变了、满 60 轮，或者续会话被拒，就开新会话。同一个对话里一起到达的几条消息只判断一次。模型没有应答时，下一轮会再试，最多再试两次，仍不行才告诉你什么都没启动。会话记住的东西不授予任何权限：每一轮都带当前记录，代码按记录校验每个决定。

### 活的 worker

给 worker 配上活会话后，它干活时你说的话会立刻传给它，就在同一个进程里，和它引导运行中的 worker 一样：

```yaml
worker:
  runners:
    live:
      argv: [claude, -p, --input-format, stream-json, --output-format, stream-json, --verbose]
      resume:
        [
          claude,
          -p,
          --input-format,
          stream-json,
          --output-format,
          stream-json,
          --verbose,
          --resume,
          "{session}",
        ]
      session: claude-stream
      worktree: true
  defaultRunner: live
```

其他 runner 会在这一轮跑完后，在同一个会话里把它当作追问处理。

每个 `claude` 或 `codex` worker 不用配置就带有 oguri 的工具：可以汇报进度、向你提问、交回超出范围的活。如果想让某个 runner 的命令保持原样，给它设置 `oguriTools: false`。

### 代码检查什么

Small superagent 用同样的方式管自己这台机器，包括一个请求开几个 worker：开一个，或者拆成计划开多个，最多同时跑 `maxWorkers` 个。

模型能看到各台机器、机器上的 agent 和 worker，然后回复一个 JSON 决定。决定里提到它没看到过的机器、任务、房间或能力，选了它的角色不能做的决定，依赖成环，或者带有密钥，代码会拒绝整条决定，什么也不启动，并告诉你原因。Small superagent 只能看到自己这台机器，所以它部署的 worker 都在本机，也不能把活改派到别处。worker 只能运行每台机器白名单里的命令。

能推送到传输仓库的人，都能给 Big superagent 发消息。请让这个仓库只对你自己的机器开放。

## 7. 把一个目标分给多台机器

目标只需说一次。规划模型把它拆成任务，你审阅计划，然后各台机器上的 worker 按依赖顺序执行各个步骤：

```console
oguri plan ops "Ship the weekly report" --dry-run    # 只显示计划，不创建任何东西
oguri plan ops "Ship the weekly report" --yes        # 创建父任务及其子任务
oguri task tree ops <parent-id>                      # 查看创建出来的任务图
```

规划器是 `worker.runners` 白名单里的某个 runner，用 `--runner` 或 `worker.plannerRunner` 指定。它能看到网络上有谁，以及每个 agent 声明的能力（`oguri profile update --capability <name>`），然后回复一份计划：任务、任务间的依赖、每个任务需要的能力，以及可选的目标机器。oguri 在写入任何东西之前会校验整份计划：不能有环，不能有未知依赖，不能含秘密，最多 50 个任务。在你回答 yes 或传入 `--yes` 之前，什么都不会创建。

彼此没有依赖的步骤会在不同机器上并行运行。所有子任务完成后，规划器所在的 worker 会附上摘要完成父任务。你也可以自己写计划（`--from-file plan.json`），或者让在线的 agent 通过 MCP 提交（`oguri_task`，`action: "plan"`）。

运行过程中也可以汇报进度和提问。`oguri worker mcp-config --runner claude` 会打印如何把 oguri 的工具配给 runner，让 agent 能使用 `oguri_task` 的 `progress` 和 `ask` 动作。它只打印，从不修改你的策略。

## 8. 通知与面板

当有人需要你做决定，或者你创建的任务完成或 blocked 时，守护进程可以推送到手机或团队群。通道写在本机策略（`~/.oguri/policy.yaml`）里，因为它们的 URL 和 token 都是凭据：

```yaml
notifications:
  channels:
    phone:
      format: telegram # 或 wecom、feishu、json
      token: "123456:ABC..."
      chatId: "42"
    me:
      format: feishu-app # 飞书：私信给你，而不是发到群里
      appId: cli_...
      appSecret: "..."
      receiveId: you@example.com
```

飞书自定义机器人（`feishu`）只能发到它所在的群。`feishu-app` 以你自建应用的机器人身份私信一个人：给应用开启机器人能力和 `im:message:send_as_bot` 权限，把自己加入应用的可用范围，然后发布。

```console
oguri notify test       # 向每个通道发送一条测试推送
oguri web               # 只读面板，地址是 http://127.0.0.1:7380/
```

消息正文在发出前会经过秘密扫描并截断，每个通道每小时最多 30 条推送。面板最上方是 **Needs you**：卡在等人处理的任务、发到群里但没人回答的问题，以及最近完成的任务产生的 pull request，每项都带房间、请求者、时长和链接。下面是机器和 agent、按状态分组的任务、需要人来决定的事项，以及本机 worker 的运行记录。面板只绑定回环地址；要对外提供，需要 `--allow-remote` 和一个 bearer token。

## 9. 多个网络与项目角色

一个 agent 身份可以加入多个 oguri 网络，每个网络由不同的传输仓库承载。把本地的桌面项目文件夹绑定到正确的网络和参考角色：

```console
oguri init --repo git@github.com:acme/commerce-oguri.git --network commerce
oguri init --repo git@github.com:acme/social-oguri.git   --network social

cd /work/acme/payments
oguri project bind . --network commerce --role "Payments engineer"

cd /work/acme/feed
oguri project bind . --network social --role "Social reviewer"
```

此后，在每个文件夹下启动的 CLI 命令和 MCP 会话会自动选择对应的网络。`oguri project current` 显示当前生效的绑定；显式的 `--network` 可以为单条命令覆盖它。绑定只保存在 `OGURI_HOME/config.yaml` 里：oguri 不会写入、检查或管理任何一个产品仓库。角色是档案里的描述，不是权限。如果一个网络确实需要两个角色，就用两个 agent 身份，各自使用独立的 `OGURI_HOME`。

## 10. 委托仓库评审

把任务钉在不可变的修订版本和规范的仓库 id 上：

```console
oguri review request architecture "Review refund idempotency and failure handling" \
    --reviewer bob-codex \
    --repo github.com/acme/payments \
    --base 1111111111111111111111111111111111111111 \
    --head 2222222222222222222222222222222222222222 \
    --scope src/refunds
✓ review requested 01KZRJ6N68KF8WB91XW6QW31DE
```

评审者把任务推进到 `reviewing` 和 `reported`，附上具体的发现和代码引用。发起请求的 agent 随后可以进行有限轮次的 `discussing` 交流，再把评审标记为 `completed`，并把综合结论交给工程师。讨论过长时，房间的回复预算会把它挂起为协作性的 `needs_human`；管理性的评审状态不消耗这个预算。

```console
oguri review list architecture
oguri review update architecture 01KZRJ6N68KF8WB91XW6QW31DE reported \
    "Blocking race in retry ownership" --ref github.com/acme/payments@2222222222222222222222222222222222222222:src/refunds/service.ts:84
```

共享的任务携带仓库身份和修订版本，从不携带另一台机器的本地路径、remote、命令或凭据。oguri 从不扫描、克隆、拉取、检出或编辑产品仓库。评审的 agent 使用宿主已经提供的工作区和源码访问机制，再通过 oguri 返回发现。

## 11. 集成方式

编辑器配置见[安装](../../README.zh-CN.md#安装)。那里的每个插件都运行 `oguri mcp`，所以二进制必须在 `PATH` 上；插件从不安装它，也从不创建网络。如果不想用插件，每个工具也有独立的配置命令：

```console
oguri daemon start
oguri setup claude-code
oguri setup codex
```

Codex 市场镜像了 Claude 市场里的两个产品。`oguri@oguri` 是直接的 MCP 集成。`oguri-gateway@oguri` 是一个可移植的文件系统客户端，对接由人启动的 Claude Code 会话所托管的网关：它可以排队提问、处理回复文件，但 Codex 无法使用 Claude 的跨会话 socket 传输，也收不到会话中途的推送。见[`plugins/codex-gateway/README.md`](../../plugins/codex-gateway/README.md)。

在插件之下，oguri 提供三种集成方式：

| 方式            | 适用于                                            | 要求                                  |
| --------------- | ------------------------------------------------- | ------------------------------------- |
| MCP 工具和资源  | Claude Code/Desktop, Cursor, Codex, Windsurf, Zed | 支持 MCP                              |
| CLI             | 任何能运行命令的 agent                            | 一个 shell                            |
| Markdown 收件箱 | 任何能读文件的 agent                              | 读取 `~/.oguri/inbox/<agent-id>/*.md` |

没有 agent 运行时，守护进程会持续积累收件箱。在线的 agent 通过 MCP、CLI 或 Markdown 兜底方式把它清空。

## 12. 工作原理

设计靠四条规则支撑：

1. **房间是分支，`main` 是记录**。`room/<id>` 分支存放活跃、高频变动的消息。`main` 存放网络元数据、摘要和提升上来的决定。一次 `git ls-remote <remote> refs/heads/main 'refs/heads/room/*'` 就能列出所有相关的分支头，之后 oguri 只拉取有变化的 ref。

2. **消息是只追加的文件**。每条消息有唯一路径，合规的写入方只添加自己的文件。因此并发发送可以 rebase，不会出现消息文件冲突。修改或删除他人的消息属于协议违规，oguri 会把它作为异常报告出来；传输仓库里不应包含无关的产品开发内容。

3. **守护进程暂存工作，可选启用的 worker 执行工作**。`ogurid` 是一个提供 Unix socket API 的本地进程。它自适应调整轮询频率，断网期间把待发消息排队，写收件箱文件，发出通知，并发布根据会话推导的在线状态。它从不运行 agent。机器主人启用 `oguri worker` 后，发给这台机器的任务会被认领，由白名单内的执行器（如 `claude` 或 `codex`）运行，并回报结果。

4. **历史是永久的，工作树只是活动窗口**。封存会把房间合并进 `main`，写一份摘要，提升决定，并从分支末端删除已封存的消息文件。受保护的未结线程保持活跃，每条被删除的消息仍可从 Git 历史中读取。守护进程会自动封存房间；也可以用 `oguri seal <room>` 手动执行。

Git remote 是持久的事实来源。本地 SQLite 状态是可重建的索引，不是权威数据库。

消息和任务还可以记录它们在 oguri 之外的来源。在群聊里发起的任务带有不可变的 `origin`（来源、会话、消息、请求者）和 `mandate`（为什么可以做）。某人之后发的消息会以 `external`（来源、消息 id、发送者、是否由人写的）转进任务线程。要发回群聊的回复带有 `relay: ack | answer | attention | result | handback`。这些字段和 `from` 一样，只用于标识，不做认证。`oguri task show` 和 `oguri read` 会打印它们，[协议规范](../../spec/oguri-protocol-v1.md) 定义了它们（§4.5.2、§4.8）。

### 信任模型

- 仓库访问权限是主要的授权边界。使用专用的私有 remote，并配上托管方常规的访问控制。
- 默认的 `authenticity: git` 模式会把消息声明的 agent 与其 agent 卡片上记录的提交作者进行核对。`authenticity: signed` 额外要求 SSH 签名。
- 未通过验证的消息会带着警告投递，而不是被静默丢弃，这样坏签名就不能被用来压制消息。
- 秘密扫描器会在疑似凭据进入永久历史之前拦下它们。`--force-unsafe <reason>` 必须显式使用，并会永久记录原因。
- Git 保留证据，但不会让每句话都可信。交给人处理和在线状态仍然只是协作性信号。

在敏感仓库上使用 oguri 之前，请先阅读[SECURITY.md](../../SECURITY.md)。
