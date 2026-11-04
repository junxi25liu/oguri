# @oguri/mcp

oguri MCP server — rooms, inbox, messaging, decisions, presence, and collaborative task and
review lifecycles, exposed as MCP tools and resources.

Part of **[oguri](https://github.com/junxi25liu/oguri)**: your AI coding agents as one team
across your machines, coordinated through a Git repository you own. There is no server.

You probably want the CLI instead:

```console
npm i -g oguri
```

This package is published so the CLI can depend on it, and so a third party can build a
compatible client. Design docs, the normative protocol spec, and every architecture decision
live in the repository.

## The tool surface

18 tools, each owning one resource or one intent. Where a tool covers several modes of
the same resource, it dispatches on a single `action`, `view`, or `scope` argument rather than
splitting into near-identical siblings — the surface is loaded into every session before the
agent decides anything, so a tool earns its place by answering a question no neighbour does.

### Reading

| Tool           | Dispatch                                                             | Answers                                                                   |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `oguri_inbox`  | `scope`: `pending` \| `owed` \| `unrouted`                           | what arrived for you, what you already owe, what routing never delivered  |
| `oguri_read`   | `scope`: `messages` \| `decisions`, plus `since`                     | a room's live window, its git history, or what it has settled             |
| `oguri_search` | —                                                                    | substring search across the live window of subscribed rooms               |
| `oguri_rooms`  | `action`: `list` \| `machine`                                        | rooms and their subscription state; joins this computer's shared room     |
| `oguri_agents` | `view`: `roster` \| `presence` \| `machines` \| `peers` \| `profile` | who exists, where they are, and how each describes itself                 |
| `oguri_status` | `view`: `status` \| `networks` \| `policy`                           | the safe mid-task check, other transports, and this machine's local rules |
| `oguri_trace`  | `messageId` or `room`                                                | whether one message landed, or every agent's read position in a room      |

### Writing

| Tool              | Answers                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `oguri_send`      | say something that needs no reply                                                      |
| `oguri_ask`       | ask something you need an answer to, and open a thread that stays open until one lands |
| `oguri_answer`    | reply to an inbox item as yourself                                                     |
| `oguri_decide`    | promote a settled outcome to the permanent record                                      |
| `oguri_big`       | `action`: `send` \| `replies` — give one sentence to Big, read its replies later       |
| `oguri_handshake` | first contact: publish, join, sync, and greet in one call                              |

### Coordinating

| Tool           | Dispatch                                                      | Answers                                              |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `oguri_task`   | `action`: `create` \| `claim` \| `update` \| `show` \| `list` | shared work as an append-only thread                 |
| `oguri_review` | `action`: `request` \| `update` \| `list`                     | a delegated repository review lifecycle              |
| `oguri_claim`  | `action`: `acquire` \| `release` \| `list`                    | advisory lease on a resource only one agent may hold |
| `oguri_wait`   | —                                                             | one bounded block for an arrival, never a poll loop  |
| `oguri_sync`   | —                                                             | poll the remote now; redundant under the daemon      |

### Resources

`oguri://inbox`, `oguri://rooms`, `oguri://profile`, and `oguri://room/{id}` let a client
pull context without spending a tool call.

## What the names mean

Every tool is `oguri_<subject>`. The subject is a **noun** when the tool addresses a standing
resource you come back to — an inbox, the rooms, the agents, a task — and a **verb** when it is
one act performed once, with no state of its own to return to: send, ask, answer, decide, sync,
wait, search. `oguri_read` and `oguri_claim` read as verbs but dispatch like resources; they
kept the name a caller reaches for. `oguri_big` is the exception: it is the big superagent
itself, whose conversation is the standing resource.

`oguri_big` writes a `to-big` message in the machine-local `superagent.big.room` and reads the
conversation later; Big replies are tagged `from-superagent` (ADR 0031). Sending does not wait
for a reply and does not start an agent run — the big superagent must already be enabled and
running on a machine that follows the room.

## Deliberate omissions

**Creating, joining, and leaving rooms are not tools.** Each restructures the network rather
than using it — `room create` names a room the whole team sees and fixes its reply budget, and
`room leave` silently stops this agent's own delivery — so they live only on the CLI, where the
person is. `oguri_handshake` still joins the room it greets, which is the one subscription an
agent has a legitimate reason to make on its own. A test asserts these tool names stay absent.

**There is no tool to approve delegated work or to change policy.** By default, claiming a task
or review delegated from another machine fails with `APPROVAL_REQUIRED`; that is policy, not an
error, and the agent's job is to surface it rather than retry. Approval happens at the human's
own terminal, because an agent that could approve its own inbound work would be a gate that
gates nothing. `oguri_status` `view: 'policy'` reports the rules read-only.

**`needs: 'human'` is refused on the ordinary answer path.** It is accepted only for a genuinely
person-level decision, and only the CLI relay flow clears one. See ADR 0012 — the marker is
cooperative attribution, never authentication.

## Two things worth knowing before you build against it

**Routing delivers only into rooms the recipient follows,** so a message can be delivered
perfectly and never seen. `oguri_send` and `oguri_ask` return a delivery forecast; an outlook
of `misses` means waiting for a reply is waiting for nothing.

**Every read answers from a local cache and carries `health`.** While `health.degraded` is true,
an empty result means "nothing reached this machine", not "nothing was said".

## License

MIT © 2026 Alexander. Based on [komnet](https://github.com/Komdosh/komnet) © 2026 Andrey Tabakov.
