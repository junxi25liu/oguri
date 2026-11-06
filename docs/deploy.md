# Deploy oguri on a new machine

This is the whole path from an empty machine to a team that takes work: install, connect to a
transport, configure the worker and the superagents, add a second machine, and keep it running.
Every step has a command to copy and a way to tell it worked. If a step does not behave as
described, jump to [Troubleshooting](#10-troubleshooting).

Two ideas make the rest easy to follow:

- **The transport is a Git repository you own.** Machines never talk to each other directly.
  They push and pull messages through it, so a machine that can `git push` to it is on the team.
- **Nothing runs until the machine's owner allows it.** What a machine may execute is decided in
  one local file, `~/.oguri/policy.yaml`, which oguri reads and never writes. No message from the
  network can change it.

Contents: [1 Prerequisites](#1-prerequisites) · [2 Install](#2-install) ·
[3 The first machine](#3-the-first-machine) · [4 Policy](#4-configure-policy) ·
[5 Talk to the superagents](#5-talk-to-the-superagents) · [6 A second machine](#6-add-a-second-machine) ·
[7 Day to day](#7-day-to-day) · [8 Upgrade](#8-upgrade-from-101) · [9 Safety](#9-safety-model) ·
[10 Troubleshooting](#10-troubleshooting) · [11 Check the whole thing](#11-prove-it-works-without-a-paid-model)

## 1. Prerequisites

| You need                         | Why                                                                      | Check                      |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| macOS or Linux (x64 or arm64)    | Windows has no packaged build; use WSL                                   | `uname -sm`                |
| Node.js 24 or later              | oguri runs on it (not needed for the single-file binary)                 | `node --version`           |
| Git 2.42 or later                | A room is an orphan worktree; `worktree add --orphan` needs 2.42         | `git --version`            |
| A Git identity                   | Every message is a commit                                                | `git config user.email`    |
| Claude Code or Codex CLI         | What a worker actually runs. Skip it if the machine only relays messages | `claude --version`         |
| That CLI signed in               | A worker cannot answer a login prompt                                    | run `claude` once, by hand |
| pnpm (only when building source) | `pnpm install && pnpm build`                                             | `pnpm --version`           |
| A transport repository           | See below                                                                | `git ls-remote <url>`      |

**The transport** must be a dedicated, empty, **bare** repository, not your product repository.
Messages are commits on orphan branches, and a non-bare repository with `main` checked out
refuses the push. Pick one:

| Transport                              | Use when                          | Create it                                                    |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| Private repository on GitHub or GitLab | Machines on different networks    | Create an empty private repo; give every machine push access |
| Bare repository on a shared path       | Machines share a filesystem (NFS) | `git init --bare /shared/oguri-transport.git`                |
| Bare repository on this machine        | One machine, or a trial run       | `git init --bare ~/oguri-transport.git`                      |

Everyone who can push to the transport can write to your superagents, so keep it private to your
own machines. Messages are permanent: do not put secrets in them (oguri's scanner refuses the
obvious ones).

## 2. Install

Pick one. All four put an `oguri` command on your `PATH`, and none of them uses `sudo`.

| Method             | Use when                                     | Command                                                         |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------- |
| npm                | The machine has Node 24+ (the usual case)    | `npm i -g oguri`                                                |
| `install.sh`       | You want a release binary and have `gh`/curl | `./install.sh`                                                  |
| Single-file binary | No Node on the target machine                | `pnpm binary`, then `./install.sh --from-binary dist-bin/oguri` |
| Source             | You are changing oguri itself                | `./install.sh --source-dir .` (needs pnpm)                      |

```console
npm i -g oguri
oguri --version
```

You should see the version, for example `1.0.5`. If the shell says `command not found`, the npm
global `bin` directory is not on `PATH`; `npm prefix -g` prints where it is.

The single-file binary is built per platform and cannot be copied between macOS and Linux or
between arm64 and x64: build it on a machine of the same kind.

```console
# On a build machine with the source tree
pnpm install && pnpm binary                         # writes dist-bin/oguri
scp dist-bin/oguri gpu-box:/tmp/oguri
ssh gpu-box ./install.sh --from-binary /tmp/oguri   # installs to ~/.local/bin
```

`install.sh` installs to `~/.local/bin`; if that directory is not on `PATH` it prints the line to
add. It never edits your shell configuration.

## 3. The first machine

### 3.1 Initialise

Use a real name for the agent. It identifies who wrote each message, forever.

```console
oguri init --repo git@github.com:acme/oguri-transport.git --agent alice-mac
```

A local bare repository works the same way (a plain path, no `file://`):

```console
git init --bare ~/oguri-transport.git
oguri init --repo ~/oguri-transport.git --agent alice-mac
```

Success looks like:

```text
✓ initialised a new network
✓ agent card published as alice-mac
✓ config written to /home/user/.oguri/config.yaml
```

On the second and later machines it says `joined existing network` instead. If it exits `1` with
`remote rejected … currently checked out`, the transport is not bare; see
[Troubleshooting](#10-troubleshooting).

Tell peers what this machine covers, so Big and Small can route work to it:

```console
oguri profile update --role "builds and tests the app" --responsibility "acme/app"
```

### 3.2 Check

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

`✓` is fine, `!` is a warning worth reading, and `✗` is a problem. `doctor` also checks every
runner command in your policy against `PATH` and whether `worker.workdir` is a Git repository.

### 3.3 Start the daemon

The daemon syncs with the transport in the background and fills the inbox while no agent runs.

```console
oguri daemon start
oguri daemon status
```

```text
✓ running (pid 36413)
● running · /home/user/.oguri/daemon.sock
```

To start it at every login: `oguri daemon install` (launchd on macOS, `systemd --user` on Linux).
If `daemon start` says the socket path is too long, your `OGURI_HOME` is too deep; unix sockets
allow about 100 bytes, so keep it short (the default `~/.oguri` is fine).

### 3.4 The dashboard

```console
oguri web                    # http://127.0.0.1:7380, read-only, loopback only
oguri web --port 7391        # another port
```

Open the address in a browser, or check it from the shell: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7380/`
prints `200`. The page opens on **Needs you**. `/chat` on the same server is the conversation page
for Big and Small (section 5). Serving beyond loopback needs `--allow-remote` and prints a bearer
token; do not expose it to the internet.

## 4. Configure policy

Everything a machine may run is in `~/.oguri/policy.yaml`. `oguri policy --init` writes a
commented starting point; `oguri policy` prints what oguri read back and which file it came from.
Edit the file; oguri never rewrites it, so your comments survive. Most changes apply on the next
pass of the running worker; restart `oguri superagent start` or `oguri worker start` to be sure.

### 4.1 The smallest working setup

One machine, one worker, no superagents. Tasks addressed to this machine run with Claude Code:

```yaml
v: 1
worker:
  enabled: true
  workdir: ~/code/app # a Git repository; each run gets its own worktree of it
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

Check it:

```console
oguri policy
oguri doctor
```

`oguri policy` should show `enabled  yes — runners: claude`, and `doctor` should say
`worktree base … is a Git repository` and `'claude' is on PATH`.

### 4.2 Worker settings

| Key                           | Default   | Meaning                                                                                                                           |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `worker.enabled`              | `false`   | Master switch. Nothing runs while it is `false`.                                                                                  |
| `worker.workdir`              | `~`       | Directory a run starts in; with `worktree: true` the repository it branches from.                                                 |
| `worker.concurrency`          | `1`       | Runs at once, 1 to 20. One extra slot is kept for follow-ups.                                                                     |
| `worker.maxPerHour`           | `6`       | Runs started per rolling hour, 1 to 120. It survives a restart.                                                                   |
| `worker.timeoutMinutes`       | `180`     | One run's limit, 1 to 1440. The whole process group is killed, then the retry rules apply. A config that sets it keeps its value. |
| `worker.defaultRunner`        | first     | Runner a task uses when it names none.                                                                                            |
| `worker.plannerRunner`        | default   | Runner `oguri plan` thinks with.                                                                                                  |
| `worker.trustedRequesters`    | `[]`      | Agents whose remote tasks run without `oguri task approve`.                                                                       |
| `worker.onAbandon`            | `release` | A run cut off by a crash: `release` it to another machine, or `block` it here.                                                    |
| `worker.retry.backoffMinutes` | `10`      | How long this machine waits before retaking a task it released after a failure.                                                   |
| `worker.followupDays`         | `14`      | Days after completion during which a person's follow-up reruns the task.                                                          |
| `worker.maxTaskDepth`         | `2`       | How deep a run may nest the subtasks it creates, 0 to 8.                                                                          |
| `worker.capabilities`         | `[]`      | Names this worker asserts, so `--requires gpu` tasks find it.                                                                     |

**Which concurrency is in force.** `worker.concurrency` is the limit for a plain worker. When the
small superagent is on, `superagent.small.maxWorkers` (default 3, at most 20) replaces it, because
Small decides how many workers a request needs. `oguri worker status` and `oguri superagent
status` print the value in force and where it came from, for example
`3 at once (superagent.small.maxWorkers; worker.concurrency is 2)`.

### 4.3 Runners

A runner is an allow-listed command: an argv list, run with **no shell**, with the task text on
stdin. A task can pick a runner by name (a first line `runner: cheap`) but can never add an
argument.

```console
oguri runner presets      # ready-made blocks, with comments in English and Chinese
```

Paste the ones you need under `worker.runners`. A preset such as `cheap` shows how a runner
names its model. The model name in the presets is a **placeholder**: replace it with a model your
own provider or gateway serves. If `claude` must reach a model on a gateway, point
`ANTHROPIC_BASE_URL` (and the authentication variable your gateway needs) at it in the
environment the worker runs in.

| Runner key          | Meaning                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `argv`              | The command. First word must be on `PATH` (`doctor` checks).                                             |
| `model`             | Adds `--model <m>` for `claude` or `-m <m>` for `codex`, unless the argv already chose one.              |
| `effort`            | Adds `--effort <level>` for `claude`. Refused on any other command.                                      |
| `efforts`           | The only effort levels a task may ask for with an `effort:` line.                                        |
| `worktree`          | Run in a fresh Git worktree of `workdir`, on branch `oguri/<task>-<run>`.                                |
| `workdir`           | Overrides `worker.workdir` for this runner.                                                              |
| `session`, `resume` | How a session id is learned and continued: `claude-json`, `codex-jsonl`, `claude-stream` (live), `file`. |
| `oguriTools`        | Give a `claude`/`codex` run oguri's tools (progress, ask, handback). On by default.                      |
| `requireResult`     | A run that exits 0 without writing `result.json` is retried or blocked, not completed.                   |

**Forbid pushing.** Put `--disallowedTools "Bash(git push:*)"` in every Claude worker's argv, as
the presets do. The worker boxes the run in with its argv and nothing else; it is the argv you
write that decides what the agent may do.

### 4.4 Tiers: cheap first, climb on failure

`worker.tiers` groups runners you already listed into rungs, cheapest first. The superagents
choose a tier by difficulty (default: the cheapest), and a failed run of a tiered task moves it
one rung up.

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
    cheap: cheap # a tier is a runner name,
    standard: # a list of them,
      runners: [standard] # or a mapping with runners
      effort: medium # and an optional default effort (must be on every runner's `efforts`)
    strong: strong
  escalation:
    maxSteps: 2 # a failed run may climb at most 2 rungs; 0 (default) never climbs
```

Rules the parser enforces: a tier names only existing runners; a runner sits in one tier; at most
8 tiers; `escalation.maxSteps` above 0 needs at least two tiers. A task asks for a tier with
header lines at the top of its text:

```text
runner: standard         # pick a runner (a task pinned to a runner never climbs)
tier: standard           # or pick a tier
tier-reason: touches the payment path
effort: high             # must be on the runner's `efforts`
```

A tier that cannot run on a machine is refused with the reason; it is never silently swapped for
another runner. `oguri worker runs` records the tier, the reason, and any escalation.

### 4.5 Runner grants: a person says yes to each runner

By default every runner in `worker.runners` may run. Turn on grants and a runner runs only after a
person at that machine's terminal grants it, bound to the runner entry as it is now; edit the
argv, model, effort, resume or workspace keys afterwards and the grant stops applying until it is
granted again.

```console
oguri runner list                                  # each runner, whether it is granted, who asked
oguri runner grant cheap --expires 7d              # interactive only; asks y/N; the first grant turns grants on
oguri runner grant standard --for alice-big        # only tasks from alice-big
oguri runner revoke standard                       # takes effect on the worker's next pass, no restart
oguri runner request strong "a hard refactor"      # anyone, including an agent: asks, grants nothing
```

`grant` and `revoke` refuse inside a worker's run and from a pipe, so neither Big, Small nor a
worker can grant itself a runner. Every grant, revoke, refusal and request is appended to
`runner-audit.jsonl` beside `policy.yaml`. Grants live in `grants.json` (mode `0600`) and are never
published. With no grants file, nothing is enforced: a machine behaves as before.

When a task waits for an ungranted runner, the worker posts a request with `needs: human`, and Big
passes it to you. A grant takes effect immediately. A machine with grants on and none valid runs
nothing, and `oguri worker status` says so.

### 4.6 The superagents

```yaml
superagent:
  big: { enabled: true, runner: brain } # on ONE machine: the agent you talk to
  small: { enabled: true, big: alice-big, maxWorkers: 3 } # on EVERY machine with a worker
```

| Key                          | Default                         | Meaning                                                                         |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `big.runner`, `small.runner` | planner                         | A `worker.runners` entry it thinks with. Give it a no-tool runner (`--tools=`). |
| `big.room`, `big.workRoom`   | `superagent`, `superagent-work` | Where you talk to them, and where workers' tasks go.                            |
| `big.coordinate`             | `true`                          | Act on Small's reports and move a worker nobody picked up.                      |
| `big.githubCli`              | `gh`                            | Follows a worker's pull request until it merges or closes.                      |
| `small.big`                  | none                            | The Big agent id. Its workers run here with no `oguri task approve`.            |
| `small.maxWorkers`           | `3`                             | Workers at once on this machine, 1 to 20. Replaces `worker.concurrency`.        |
| `small.quietMinutes`         | `30`                            | A held task with no update for this long is reported.                           |

The `brain` runner (print it with `oguri runner presets`) uses `--tools=` so the model decides and
dispatches but never acts; real work is always a task a worker runs.

### 4.7 A full multi-tier example

This parses as written (tested with `oguri policy`). Replace the placeholder model names and the
workdir.

```yaml
v: 1
approvals:
  inboundWork: remote # ask a person before taking work delegated from another machine
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

`oguri policy` prints `3 at once (superagent.small.maxWorkers; worker.concurrency is 2)`,
`12/hour`, `180 min`, and `trusted alice-big`.

## 5. Talk to the superagents

Start the roles this machine's policy enables:

```console
oguri superagent start &          # big and/or small, with this machine's workers
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

| Role   | Where it runs | What it does                                                                                                                    |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Big    | one machine   | Your single point of contact. Plans, deploys workers on any machine, relays your messages, moves or stops workers, answers.     |
| Small  | every machine | Decides how many workers a request needs here, runs them up to `maxWorkers`, reports quiet or stuck ones, answers you directly. |
| Worker | one per task  | Claude Code or Codex in its own worktree. Reports progress, asks questions, hands back work beyond its task.                    |

Code checks every decision a model makes. A decision naming a machine, task, room or capability it
was never shown, a role it may not take, a cycle, or a secret is refused and nothing starts.

### Ways to talk

```console
oguri big "add a dark-mode toggle to the settings page"   # waits for the first reply
oguri big "also the Cancel button" --detach               # reply lands in: oguri read superagent
oguri small machine:gpu-box "how is the benchmark going?"
oguri chat                                                # an interactive terminal conversation
oguri chat --target machine:gpu-box                       # with one machine's Small
```

In `oguri chat`: `/targets`, `/target <name>`, `/history`, `/help`, `/exit`. With `oguri web`
running, the same conversation is at `http://127.0.0.1:7380/chat?target=big`. If nothing replies,
check that `oguri superagent start` is running: the message waits in the transport for it.

### Filing work directly

Tasks are plain messages; you can skip Big and put one on a machine yourself. Header lines at the
top choose how it runs:

```console
oguri task create ops "runner: standard
tier-reason: touches billing
effort: high

Add idempotency keys to the refund client." --machine gpu-box --title "Refund idempotency"
```

### Follow progress

| You want              | Run                                                      |
| --------------------- | -------------------------------------------------------- |
| Who is doing what     | `oguri superagent status` · `oguri team` · `oguri web`   |
| This machine's worker | `oguri worker status` (policy, hourly budget, running)   |
| Recent local runs     | `oguri worker runs --limit 20`                           |
| One task in full      | `oguri task show <room> <id>`                            |
| A room's tasks        | `oguri task list <room>` · `oguri task tree <room> <id>` |
| The raw conversation  | `oguri read superagent`                                  |

**Cost and model evidence.** `oguri superagent status` prints today's cost as a **known subtotal**
and says how many runs it does not cover, because some runners print no price. It counts worker
runs only, not the Big and Small brain sessions. A run is never counted as $0. The dashboard's
**Runs & cost** view shows each run's model evidence by source: what the argv requested, what the
CLI reported at start, and what the answer's usage reported. These are labels, not proof of which
weights answered, and a gateway may rewrite the model name; trust them accordingly. Each run's
`run.json` under `~/.oguri/runs/<task>/<run>/` records the tier, tier reason, effort and its
source, escalations, and reaped background processes.

## 6. Add a second machine

On the new machine, install (section 2), then join the **same** transport with a **different**
agent name:

```console
oguri init --repo git@github.com:acme/oguri-transport.git --agent gpu-box
oguri daemon start
oguri doctor
```

`init` says `joined existing network`. Write that machine's policy: its own worker and runners,
and Small pointing at the Big agent. It does **not** need a Big.

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
  small: { enabled: true, big: alice-mac, maxWorkers: 2 } # alice-mac is the Big agent's id
```

```console
oguri superagent start &
oguri team
```

`oguri team` lists every machine, agent and capability on one screen, and this machine's runners
and concurrency. Within a minute the first machine should list `gpu-box`. From now on `oguri big`
can put work on either one, and you can address a machine directly: `oguri small machine:gpu-box "…"`
or `oguri task create ops "…" --machine gpu-box`.

**Delegated work asks first.** With the default `approvals.inboundWork: remote`, a task from
another machine waits for `oguri task approve <room> <id>` on the receiving machine, unless the
requester is in `worker.trustedRequesters` or is the Big named in `small.big`.

**When a machine goes offline.** Messages and tasks stay in the transport. Nothing is lost and
nobody is blocked: Big sees the machine stop reporting, and with `coordinate` it moves a task
nobody picked up for 30 minutes to another machine. When the machine returns it syncs, finds its
tasks, and a run that was cut off is released (`onAbandon: release`, the default) so another machine
may take it, or blocked (`block`) for you to look at. Run `oguri worker install` and
`oguri daemon install` so a reboot brings it back by itself.

## 7. Day to day

**Things that need you.** `oguri web` opens on **Needs you**. From the shell:

```console
oguri inbox                                   # pending messages
oguri task agenda --mine                      # unfinished work across rooms
oguri task approve <room> <id>                # let a delegated task start
oguri answer <message-id> "Use the 10k sample." --as-human   # answer a needs-human question; asks y/N
```

`needs: human` is cooperative: agents cannot clear it, but `--as-human` is not proof of who was at
the keyboard.

**Follow up, resume, cancel.** Say something in a task's thread (`oguri big "use the 10k sample"`
or a message in the thread) and the worker resumes the same session in the same directory, up to
`followupDays` after completion. A live runner (`session: claude-stream`) hears it mid-run. Stop
work with `oguri big "stop the load test"`, or `oguri task update <room> <id> cancelled "why"` if you created it.

**Where things are.**

| What                | Where                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Config              | `~/.oguri/config.yaml` (oguri rewrites it), `~/.oguri/policy.yaml` (yours)           |
| Daemon log          | `~/.oguri/logs/daemon.log`                                                           |
| A run's files       | `~/.oguri/runs/<task>/<run>/`: `stdout.log`, `stderr.log`, `run.json`, `result.json` |
| Superagent sessions | `~/.oguri/superagent/*-session.json`                                                 |
| Grants and audit    | `~/.oguri/grants.json`, `~/.oguri/runner-audit.jsonl`                                |
| Cache               | `~/.oguri/state.db` (safe to delete; rebuilt from Git)                               |

**Back up.** `policy.yaml` is the only file that is yours alone and not derived: copy it. The
transport repository is the record of everything else; a clone of it is a full backup, and
`config.yaml` can be recreated with `oguri init`. Do not back up `state.db`.

**Upgrade.** `npm i -g oguri@latest` (or reinstall the binary), then restart what is running:
`oguri daemon stop && oguri daemon start`, and restart `oguri superagent start` / `oguri worker
start`. Run `oguri doctor` afterwards. A run in flight when the worker stops is found on the next
start and handled by `onAbandon`.

## 8. Upgrade from 1.0.1

Your `policy.yaml`, `config.yaml` and transport stay valid: every 1.0.1 key still parses, and every
new key is optional. Steps:

1. `npm i -g oguri@1.0.5`, then `oguri --version`.
2. Restart the daemon and the superagent or worker process (`oguri daemon stop && oguri daemon start`).
3. `oguri doctor` and `oguri policy` should read back the same policy.
4. Nothing else changes unless you opt in. New and worth reading:
   - **Default run limit is now 180 minutes** (was 60). A policy that writes `timeoutMinutes` keeps it.
   - `worker.tiers` and `worker.escalation` (section 4.4), runner grants (4.5), `worker.maxTaskDepth`.
   - A worker's run can now write only to its own task and its subtasks.
   - Tasks are taken by priority, then oldest first.
   - `oguri chat`, the `/chat` page, and the redesigned dashboard.
   - A run that exits 0 without `result.json` is now reported as such; `requireResult: true` makes it a retry.
5. Grants stay **off** until the first `oguri runner grant`, so nothing stops working by upgrading.

A mixed fleet works: older and newer machines exchange messages through the same transport. An
older client rejects the new `relinked` task action instead of misreading it, so upgrade every
machine before you use `oguri task update … relinked`.

## 9. Safety model

- **Repository access is the boundary.** Only machines that can push to the transport take part.
- **The owner decides.** Workers, superagents, intake and notifications are configured in the
  machine-local `policy.yaml`. No message can change it, and oguri never writes it.
- **Inbound approval.** `approvals.inboundWork: remote` (the default) makes a person approve work
  delegated from another machine. `never` is full autonomy; `always` asks for everything.
- **An allow-list of commands, no shell.** A runner is an argv list. A task chooses among runners
  by name and can never add an argument; the task text reaches the agent on stdin.
- **Runner grants.** With grants on, a runner runs only under a person's explicit, revocable,
  audited grant that is bound to the entry as written.
- **Boxed in.** A concurrency cap, an hourly cap, a timeout that kills the whole process group,
  and a worker's writes limited to its own task. Forbid `git push` in the argv.
- **Secrets stay out of history.** Messages, run summaries, pushes and chat replies pass a secret
  scanner that refuses and never echoes the value.
- **Chat intake** admits requests only from listed people in listed chats, decided by code.

Read [SECURITY.md](../SECURITY.md) before connecting sensitive repositories.

## 10. Troubleshooting

Start with `oguri doctor`; it checks Git, config, the transport, worktrees, every runner command
and the superagent session files.

| Symptom                                                              | Cause and fix                                                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `! [remote rejected] main -> main (branch is currently checked out)` | The transport is not bare. `git clone --bare <repo> <transport>.git` and `oguri init` again.                                                                                |
| `oguri init` hangs or says the remote is unreachable                 | Check `git ls-remote <url>` with the same credentials the machine uses; SSH keys or a token must work without a prompt.                                                     |
| `timed out … waiting for …/lock (held by pid …)`                     | Another oguri process holds the network lock. If that process is gone, delete the named lock file.                                                                          |
| `oguri is not configured`                                            | No network on this machine, or the wrong `OGURI_HOME`. Run `oguri init`.                                                                                                    |
| `daemon did not come up within 4s`                                   | Read `~/.oguri/logs/daemon.log`. A very long `OGURI_HOME` also breaks it: the socket path must be under about 100 bytes.                                                    |
| `oguri big` says no reply yet                                        | `oguri superagent start` is not running for Big, or Big's runner is failing. Run it in a terminal and read its output; `oguri doctor` checks the runner's command.          |
| `runner 'claude': 'claude' not on PATH`                              | The worker's environment lacks it. A login service has a shorter `PATH` than your shell: use an absolute path in `argv`, or start the worker from a shell that has it.      |
| The task sits with the worker and nothing runs                       | Either a remote task is waiting for `oguri task approve`, a runner is waiting for a grant (`oguri runner list`), or `maxPerHour` is spent (`oguri worker status`).          |
| `✗ runner grant refused`                                             | By design: only a person at an interactive terminal grants. Run it yourself, not from a script or a run.                                                                    |
| A run was killed at the limit                                        | It exceeded `worker.timeoutMinutes` (default 180). Raise it, up to 1440, or split the task. The task is retried or blocked by `worker.retry`.                               |
| The model in `worker runs` is not the one you asked for              | Model evidence is a label. A gateway can rewrite the name; check the gateway. `oguri worker runs` and the dashboard separate what was requested from what the CLI reported. |
| Concurrency shows a different number than `worker.concurrency`       | The small superagent is on, so `superagent.small.maxWorkers` is in force. `oguri worker status` shows both.                                                                 |
| `unknown key 'worker.…'` on every command                            | A typo in `policy.yaml`. The parser refuses what it does not know; the message names the key and lists the valid ones.                                                      |
| Messages sent, nobody sees them                                      | `oguri status` for queued work; sends queue silently while the remote is unreachable.                                                                                       |

## 11. Prove it works without a paid model

You can check a deployment end to end with a stand-in runner that writes a result and calls no
model. Use a scratch home so it cannot touch a real one.

```console
export OGURI_HOME=/tmp/oguri-try           # keep it short; sockets have a path limit
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
oguri task list ops              # the task reads 'completed'
```

Then `oguri worker runs` shows the run, and `oguri web --port 7391` answers `200`. Remove
`/tmp/oguri-try*` when done.
