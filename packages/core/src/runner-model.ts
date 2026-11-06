/**
 * `model` and `effort` on a runner: one place decides what those fields mean
 * (ADR 0032).
 *
 * The owner writes the argv into the machine-local policy; a task can never
 * supply one. Without `model`, oguri adds nothing. With it, the flag is added
 * to a `claude` or `codex` argv as the last arguments: `--model <m>` or
 * `-m <m>`. An argv that already chose a model keeps its owner's choice, and
 * so does a `resume` argv. A different command keeps its argv unchanged: oguri
 * has no way to know what its flag would mean.
 *
 * `effort` follows the same shape with one deliberate difference: the only
 * command whose effort flag oguri knows is `claude` (`--effort <level>`), so
 * `worker.runners.<name>.effort` is refused at parse time for any other
 * command rather than silently doing nothing. That keeps a task's request
 * from being accepted and then ignored.
 *
 * This lives in core because the worker, the superagents, and `oguri plan`
 * each resolve an allow-listed runner, and their calls must agree about which
 * model and effort the owner asked for.
 */

export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * An effort level a runner accepts: one short token with no leading `-`, so a
 * value can never be read as a flag of its own. The policy allow-list is what
 * decides which of these a task may ask for; this only bounds the shape.
 */
export const EFFORT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Which agent CLI an argv runs, by the command's basename. */
export function runnerFlavor(argv: readonly string[]): "claude" | "codex" | undefined {
  const command = argv[0] ?? "";
  const name =
    command
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat)$/i, "")
      .toLowerCase() ?? "";
  return name === "claude" || name === "codex" ? name : undefined;
}

/** The flag a runner uses to choose a model, if its command is known. */
function modelFlag(argv: readonly string[]): string | undefined {
  const flavor = runnerFlavor(argv);
  if (flavor === "claude") return "--model";
  if (flavor === "codex") return "-m";
  return undefined;
}

/**
 * True when the owner already chose a model in this argv. Both spellings of
 * the CLI flags are recognised, so a codex argv with `--model` does not get a
 * second `-m`. A codex `-c model=...` override counts too.
 */
function hasModel(argv: readonly string[]): boolean {
  return argv.some((part, index) => {
    if (part === "--model" || part === "-m") return true;
    if (part.startsWith("--model=") || part.startsWith("-m=")) return true;
    if (/^-m[^-=\s]/.test(part)) return true;
    return part === "-c" && /^\s*model\s*=/.test(argv[index + 1] ?? "");
  });
}

/**
 * An argv with the runner's model, when it has one and its command understands
 * the flag. Appending keeps the owner's arguments in their order and avoids
 * putting a value before a positional argument such as codex's `-`.
 */
export function withRunnerModel(argv: readonly string[], model: string | undefined): string[] {
  if (model === undefined) return [...argv];
  const flag = modelFlag(argv);
  if (flag === undefined || hasModel(argv)) return [...argv];
  return [...argv, flag, model];
}

/** The flag a runner uses to choose its reasoning effort, if its command knows one. */
function effortFlag(argv: readonly string[]): string | undefined {
  return runnerFlavor(argv) === "claude" ? "--effort" : undefined;
}

/**
 * True when the owner already chose an effort in this argv, in either spelling.
 *
 * `--effort-max` and similar are not the effort flag, so a value is only
 * recognised when it is exactly `--effort` (with or without `=`) or an
 * attached `--effort=...`. There is no short form.
 */
function hasEffort(argv: readonly string[]): boolean {
  return effortIn(argv) !== undefined;
}

/**
 * The effort flag an argv already carries, and the level it names, as written.
 *
 * Both spellings are recognised. A bare `--effort` with nothing after it is
 * reported with an empty level rather than guessed at: the argv is the owner's,
 * and a missing value is still a choice oguri must not override.
 */
function effortIn(argv: readonly string[]): { flag: string; level: string } | undefined {
  for (const [index, part] of argv.entries()) {
    if (part === "--effort") {
      const next = argv[index + 1];
      // A following flag, or nothing, is not this flag's value.
      if (next === undefined || next.startsWith("-")) return { flag: part, level: "" };
      return { flag: `${part} ${next}`, level: next };
    }
    if (part.startsWith("--effort=")) {
      return { flag: part, level: part.slice("--effort=".length) };
    }
  }
  return undefined;
}

/**
 * Why a requested effort will not be applied, when the argv already chose a
 * different level.
 *
 * `withRunnerEffort` keeps the owner's flag — an argv written by hand outranks a
 * request from the network — but doing so silently makes a task's `effort: max`
 * look honoured when it was not. This says so, so the caller can report it.
 */
export function effortConflict(
  argv: readonly string[],
  requested: string | undefined,
  where = "argv",
): string | undefined {
  if (requested === undefined || effortFlag(argv) === undefined) return undefined;
  const existing = effortIn(argv);
  if (existing === undefined || existing.level === requested) return undefined;
  return `this runner's ${where} already sets '${existing.flag}', so the requested effort '${requested}' is not applied`;
}

/**
 * An argv with the runner's effort, when it has one and its command understands
 * the flag. The same rules as `withRunnerModel`: appended last, never twice, and
 * an unknown command is left alone. An argv that already carries `--effort` is
 * returned unchanged, including when it names a different level; `effortConflict`
 * is what turns that into a reported conflict instead of a silent one.
 *
 * `effort` is only ever a value the machine owner listed in the policy, or one
 * of those listed values that a task asked for by name; it is never free text
 * from a message. Every value is checked against `EFFORT_NAME` by the policy
 * parser, so nothing here can become an argument that looks like a flag.
 */
export function withRunnerEffort(argv: readonly string[], effort: string | undefined): string[] {
  if (effort === undefined) return [...argv];
  const flag = effortFlag(argv);
  if (flag === undefined || hasEffort(argv)) return [...argv];
  return [...argv, flag, effort];
}
