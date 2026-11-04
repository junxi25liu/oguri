# @oguri/worker

The oguri worker: it claims tasks addressed to this agent or machine, runs an allow-listed
command, and reports the result back to the task.

Part of **[oguri](https://github.com/junxi25liu/oguri)**: your AI coding agents as one team
across your machines, coordinated through a Git repository you own. There is no server.

You probably want the CLI, which runs this package as `oguri worker`:

```console
npm i -g oguri
oguri policy --init        # then set worker.enabled and worker.runners
oguri worker start
```

What it does, in order, on every pass:

- reads the machine-local policy again, so a change takes effect without a restart;
- claims ready tasks offered to this agent, this machine, or its declared capabilities;
- runs the runner's argv with no shell, the task text on stdin, in its workdir or a fresh worktree;
- keeps one agent session per task, and with `session: claude-stream` writes a person's message
  into the running session at once;
- gives `claude` and `codex` runs oguri's tools (progress, ask, handback) unless `oguriTools: false`;
- publishes the summary, branch, PR, and artifacts, or blocks the task with a question;
- retries failed runs while attempts remain, and completes a parent once its subtasks are done.

Concurrency, an hourly cap, and a timeout bound every run. A crashed worker releases its tasks on
the next start. See the [worker guide](https://github.com/junxi25liu/oguri/blob/main/docs/guide.md#4-let-a-machine-run-the-work-it-is-sent).

## License

MIT © 2026 Alexander. Based on [komnet](https://github.com/Komdosh/komnet) © 2026 Andrey Tabakov.
