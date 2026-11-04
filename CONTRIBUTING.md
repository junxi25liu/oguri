# Contributing to oguri

Thanks for looking. This document covers how to build it, what the review bar is, and —
most importantly — **the invariants that must not break**.

---

## Setup

Requires **Node 24+** (for native TypeScript execution and built-in `node:sqlite`),
**pnpm**, and **git 2.42+** (`worktree add --orphan`).

```console
pnpm install
pnpm build          # tsc --build (TypeScript 7 native compiler)
pnpm test           # builds first, then node --test
pnpm verify         # fmt + lint + build + test — this is the CI gate
```

`pnpm verify` must be green before you open a PR. There is no separate lint config to learn:
prettier and oxlint are wired into the same command.

To build the self-contained binary (embeds its own Node):

```console
pnpm binary         # → dist-bin/oguri
```

If your `node` is a Homebrew or distro build, the script will notice it cannot host a SEA
blob and fetch an official Node runtime to use as the base. That is expected, not a fault.

---

## The invariants

These are not style preferences. Each one holds up a load-bearing property of the design,
and breaking one produces a bug that is very hard to trace back.

### 1. Append-only writes

> An agent may only **create** files. The only files it may modify are its own agent card
> and its own read receipts.

This is what makes `git pull --rebase` structurally unable to conflict, which is why there
is no merge-resolution logic anywhere in the codebase. If you find yourself wanting to edit
an existing message, the answer is a new message that references it.

Sealing is the single exception, and it holds a distributed lock.

### 2. Only the worker starts agent runs, and only by local consent

By default oguri starts nothing. Work is **staged** into an inbox and drained by a live agent.

`@oguri/worker` is the single component that may start an agent run. It does so only when the
machine owner sets `worker.enabled` in `~/.oguri/policy.yaml`. It claims the task first, runs an
allow-listed argv command with no shell, and passes message text as data. The daemon, CLI, and
MCP server never start an agent.

### 3. `needs: human` uses cooperative relay attribution

The ordinary MCP and daemon paths refuse these answers, and the state layer keeps them
pending until the explicit `--as-human` relay flow records an answer. This reduces accidental
misattribution but does not authenticate a person: agents and humans share the same OS and
terminal authority. Never describe `author_kind: human` as proof of human approval.

### 4. The secret scanner refuses; it never warns

Git history is permanent, so a leaked credential can only be rotated, not recalled. And a
finding **never carries the matched value** — not in errors, not in logs. There is a test
asserting the scanner does not leak secrets into its own output. Keep it passing.

### 5. `state.db` is a cache, never a source of truth

Every row is derivable from git. Deleting the file must lose nothing. If you add a column,
bump `SCHEMA_VERSION` — the schema mismatch path **discards and rebuilds** rather than
migrating, and that is deliberate.

### 6. Protocol changes need a spec update

`spec/oguri-protocol-v1.md` is normative. Adding an **optional** header field does not bump
the protocol version, and readers must preserve unknown fields verbatim. Anything a version-1
peer cannot safely ignore does bump it, and needs a written design decision in the pull request.

### 7. Erasable syntax only

Node's type stripping forbids `enum`, `namespace`, and parameter properties. Enforced by
`erasableSyntaxOnly` in `tsconfig.base.json`. Use `as const` objects with string-literal
union types instead — the codebase does this consistently.

---

## Tests

The suite drives **real git** against temporary repositories. That is intentional: the whole
design rests on claims about git's behaviour, and mocking git would test our beliefs about
it rather than the thing itself.

Two tests are load-bearing and should be understood before changing the transport:

- **concurrent-push convergence** (`packages/core/test`) — two clones write from the same base commit; the loser rebases and both messages survive.
- **the full two-agent conversation** (`packages/cli/test`) — spawns the real built binary and runs init → room → ask → sync → inbox → answer.

Note that CLI tests **spawn the binary** rather than calling `run()` in-process. Capturing
stdout by replacing `process.stdout.write` also swallows the test reporter's own output,
which silently reduced 17 tests to 1 before this was fixed.

For a bug fix: write the failing test first, then the minimal fix.

---

## Commits and PRs

**Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/), because
they decide the release.** Landing on `main` triggers an automatic release — but only when
the commits since the last tag actually change behaviour:

| Subject                                                                           | Effect                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `feat: …` `fix: …` `perf: …`                                                      | **patch** — `0.1.0 → 0.1.1`                     |
| `feat!: …` or a `BREAKING CHANGE:` footer                                         | **no auto-release** — asks for a manual version |
| `docs:` `chore:` `ci:` `test:` `refactor:` `style:`, or anything non-conventional | **no release**                                  |

**The automatic path only ever bumps the patch.** A `feat:` ships as a patch: minor bumps
signal scope to users and are worth choosing deliberately, not inheriting from a commit
prefix. Minor and major versions are cut by hand.

Two deliberate refusals in that table:

- **Non-releasable types release nothing.** An npm publish is permanent, so a README fix must never burn a version number.
- **A breaking change stops the pipeline** rather than shipping as a patch. A patch is the one thing users assume is safe to take, so labelling a breaking change as one would actively mislead.

The body still matters:

- Explain **why**, not what — the diff already shows what. When you rejected an alternative, say so.
- One logical change per PR.
- Update the docs in the same PR. A documented-but-missing command is a defect in an AI-first tool, because the help text _is_ the API.
- No attribution trailers in commit messages.

## Architecture decisions

Anything that changes the protocol, the git topology, the trust model, or the delivery model
needs a written design note in the pull request: context, the decision, **alternatives rejected
and why**, and the consequences. The rejected-alternatives part is the part that earns its keep
in two years.

## Releasing

Releases are cut by the maintainers from the canonical development repository. Do not publish
from a fork: an npm publish is permanent, and a fork's version numbers would collide with the
real ones.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
