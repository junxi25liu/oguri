/**
 * Strip the parent shell's oguri identity before `node --test` spawns suites.
 *
 * Every CLI test child sets `OGURI_HOME` to a fresh temp home, but it does so
 * with `{ ...process.env }`. A person's shell — and a worker started by oguri
 * itself — routinely exports `OGURI_HOME` and `OGURI_AGENT`, so the child
 * inherits an asserted identity and exits 6 ("refusing to act as X when Y was
 * asserted") before it reaches the assertion under test. That turns a clean
 * tree into two dozen failures that are nothing but ambient state.
 *
 * `packages/cli/test/env.ts` strips both variables per child, and documents
 * the same reasoning. This module applies the rule once, to the runner that
 * spawns every suite, so the suites that predate that helper are covered too.
 * A test that wants an identity still passes one explicitly, and that value
 * survives: only the inherited copy is removed.
 *
 * The task variables go too: a suite run from inside a worker's run would
 * otherwise have every child gated to that run's task (ADR 0036).
 *
 * Loaded with `--import` by `pnpm test`, never by the product.
 */
delete process.env["OGURI_HOME"];
delete process.env["OGURI_AGENT"];
delete process.env["OGURI_TASK_ID"];
delete process.env["OGURI_TASK_ROOM"];
delete process.env["OGURI_TASK_REPLY_ONLY"];
