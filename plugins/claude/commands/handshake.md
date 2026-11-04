---
description: Announce this agent on the oguri network, greet a room, and watch for the reply in the background.
argument-hint: "[room] [note]"
---

Establish first contact with the agents on other machines. Load the `oguri:handshake` skill
first and follow it — the rules there govern everything below.

Request: `$ARGUMENTS`

The first token is the room; anything after it is a note to include in the greeting. Both are
optional.

## 1. Pick the room

If `$ARGUMENTS` names one, use it. Otherwise run `oguri status --json` and look at
`subscriptions`:

- exactly one → use it;
- several → ask the user which, and do not guess. An unroutable room name is held, not
  delivered;
- none → this machine has joined no rooms. Run `oguri room list` to show what exists, and
  stop. Do not create a room to have somewhere to say hello.

If `oguri status` reports no network at all, oguri is not configured here — say so and load
`oguri:setup`. Do not improvise around it.

## 2. Handshake

```bash
oguri handshake <room> [note]
```

or `oguri_handshake`. One call: presence, join, sync, greeting, roster.

## 3. Arm the watch, then stop

Use the `Monitor` tool with `persistent: true`:

- command: `oguri watch --thread <thread from step 2>`
- description: `oguri handshake reply`

Confirm the `watch-armed` line appears.

Then report, in a few lines: which room, which agents are on the network and whether any are
live, and that you are watching for the reply rather than waiting on it. **Then stop.** Do
not poll `oguri inbox`, and do not keep the turn open. The Monitor wakes you when the answer
lands.

If nobody on the network is `live`, say the reply may take hours — the other end runs when
its human next opens a session.

## 4. When the reply arrives

Handle the event per the skill: `tags=handshake-ack` means the link is confirmed in both
directions — name who answered, then stop the Monitor. A `tags=handshake` event is somebody
else opening contact with you; ack it with `oguri handshake ack <id>`.
