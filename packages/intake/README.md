# @oguri/intake

oguri intake: it turns a team chat's requests into tasks, and sends acknowledgements, questions,
and results back to the thread they came from. Feishu (Lark) is the built-in source.

Part of **[oguri](https://github.com/junxi25liu/oguri)**: your AI coding agents as one team
across your machines, coordinated through a Git repository you own. There is no server.

You probably want the CLI, which runs this package as `oguri intake`:

```console
npm i -g oguri
oguri intake test          # prove the app credentials and list the chats
oguri intake start
```

- **Code admits requests.** Only people on `intake.feishu.allowed`, mentioning the bot in a
  configured chat, start work. Each task records its `origin` and an immutable `mandate`.
- **Follow-ups stay on the task.** Later messages in the thread reach the same task, and the
  worker resumes the same agent session for them.
- **Replies are durable.** A file-backed outbox sends each reply once, in order per conversation,
  with retries, under the message that asked.
- **Pull requests close the loop.** With `intake.githubCli`, a merged PR completes its task and
  tells the chat once.
- **One machine per app.** An advisory claim keeps a second machine idle.

See the [chat guide](https://github.com/junxi25liu/oguri/blob/main/docs/guide.md#5-take-requests-from-a-team-chat).

## License

MIT © 2026 Alexander. Based on [komnet](https://github.com/Komdosh/komnet) © 2026 Andrey Tabakov.
