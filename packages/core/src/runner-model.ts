/**
 * `model` on a runner: one place decides what the field means (ADR 0032).
 *
 * The owner writes the argv into the machine-local policy; a task can never
 * supply one. Without `model`, oguri adds nothing. With it, the flag is added
 * to a `claude` or `codex` argv as the last arguments: `--model <m>` or
 * `-m <m>`. An argv that already chose a model keeps its owner's choice, and
 * so does a `resume` argv. A different command keeps its argv unchanged: oguri
 * has no way to know what its flag would mean.
 *
 * This lives in core because the worker, the superagents, and `oguri plan`
 * each resolve an allow-listed runner, and their calls must agree about which
 * model the owner asked for.
 */

export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

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
