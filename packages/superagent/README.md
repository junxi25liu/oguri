# @oguri/superagent

The oguri superagents: one agent you talk to, which deploys workers on your machines, and a
keeper on each machine that looks after them.

Part of **[oguri](https://github.com/junxi25liu/oguri)**: your AI coding agents as one team
across your machines, coordinated through a Git repository you own. There is no server.

You probably want the CLI, which runs this package as `oguri superagent`, `oguri big`, and
`oguri small`:

```console
npm i -g oguri
oguri policy --init                       # then set superagent.big / superagent.small
oguri superagent start                    # on each machine
oguri big "rename the Save button to Submit"
oguri small machine:gpu-box "is the load test still running?"
```

What each role does:

- **The big superagent** decides each message with a model: deploy one worker or several, pass
  the message to a worker, move or stop one, answer, or ask you. It follows the workers it
  deployed and replies in the same thread when one finishes or blocks.
- **A small superagent** decides how many workers its machine runs (up to `maxWorkers`), deploys
  and looks after them, reports upward when a
  worker is blocked, stuck, or quiet, and answers when you talk to it directly.
- **A worker** is one task's agent session, run by the machine's worker engine
  ([`@oguri/worker`](https://github.com/junxi25liu/oguri/tree/main/packages/worker)).

Code checks every decision. A decision that names a machine, task, room, or capability the
superagent was not shown, a kind its role may not choose, a worker no machine would pick up, a
dependency cycle, or a secret is refused, and nothing starts. See the
[superagent guide](https://github.com/junxi25liu/oguri/blob/main/docs/guide.md#6-one-superagent-for-all-your-machines).

## License

MIT © 2026 Alexander. Based on [komnet](https://github.com/Komdosh/komnet) © 2026 Andrey Tabakov.
