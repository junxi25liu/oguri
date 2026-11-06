import type { RunRecord } from "@oguri/worker";

/** Shared by the CLI and the page; labels are evidence, never backend identity. */
export function modelEvidence(
  run: Pick<
    RunRecord,
    "modelRequested" | "modelInitialized" | "modelReported" | "modelSource" | "modelsUsage"
  >,
): string {
  const labels: string[] = [];
  if (run.modelReported) {
    const sources: Record<string, string> = {
      "assistant-message": "assistant message label",
      "result-model": "result label",
      "result-usage": "usage label",
      "cli-event": "CLI event label",
    };
    const source = run.modelSource
      ? `${sources[run.modelSource] ?? "returned label"}; ${run.modelSource}`
      : "legacy label; source unverified";
    labels.push(`${run.modelReported} (${source})`);
  }
  if (run.modelRequested) {
    labels.push(
      `${run.modelRequested} (${run.modelReported ? "requested" : "requested; service reported none"})`,
    );
  }
  if (run.modelInitialized) {
    labels.push(
      `${run.modelInitialized} (${run.modelReported ? "CLI init" : "CLI init only; response model unknown"})`,
    );
  }
  if (run.modelsUsage?.length) {
    labels.push(
      `${run.modelsUsage.join(", ")} (usage labels; no single answering model established)`,
    );
  }
  return labels.length === 0 ? "unknown" : labels.join("; ");
}
