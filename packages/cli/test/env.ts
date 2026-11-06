/**
 * The environment every CLI test hands its child process.
 *
 * A test asserts on one specific home, and writes `OGURI_HOME: home` into a
 * spread of `process.env`. That spread also inherits whatever the *parent*
 * process happened to have exported — and a person's shell, an editor, or a
 * worker launched by oguri itself routinely has `OGURI_HOME` and `OGURI_AGENT`
 * set. An inherited `OGURI_AGENT` then makes the child refuse with exit 6
 * ("refusing to act as X when Y was asserted") on every `init --agent <other>`
 * in the suite, so a clean tree reports two dozen failures that are nothing
 * but the parent's identity leaking in.
 *
 * Strip both here, once, before the extra settings are applied — so a test may
 * still set either one deliberately, and inheriting either one can never
 * happen by accident.
 */
export function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["OGURI_HOME"];
  delete env["OGURI_AGENT"];
  // Inside a worker's run these would gate every child to that run's task (ADR 0036).
  delete env["OGURI_TASK_ID"];
  delete env["OGURI_TASK_ROOM"];
  delete env["OGURI_TASK_REPLY_ONLY"];
  return Object.assign(env, extra);
}
