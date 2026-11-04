/**
 * How one run starts: which argv, what it reads on stdin, and where.
 *
 * A new task runs the runner's argv in a fresh workspace. A follow-up goes back
 * to the directory its task last ran in, and resumes the agent session there
 * when the runner can: an agent session belongs to its directory, so a resume
 * anywhere else would start cold or fail. When the directory is gone, or no
 * session is known, the follow-up runs the plain argv with the task and the
 * conversation so far.
 */

import { stat } from "node:fs/promises";

import type { Followup } from "./followup.ts";
import { allowedShellCommands, buildStdin, conversationText, resumeText } from "./prompt.ts";
import type { Candidate } from "./select.ts";
import { resumeArgv } from "./session.ts";
import type { Workspace } from "./workspace.ts";

export interface LaunchPlan {
  argv: string[];
  stdin: string;
  /** The run continues the previous run's session. */
  resumed: boolean;
  /** The previous run's directory, reused; undefined means prepare a workspace as usual. */
  reuse?: Workspace;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function planLaunch(input: {
  candidate: Candidate;
  followup?: Followup;
  /** This agent ran the task before on this machine: retry, recovery, or follow-up. */
  ranBefore: boolean;
  resultFile: string;
  exists?: (path: string) => Promise<boolean>;
  /** The run will have oguri's tools. */
  tools?: boolean;
}): Promise<LaunchPlan> {
  const { candidate, followup } = input;
  const exists = input.exists ?? isDirectory;
  const stdin = (text: string): string =>
    buildStdin({
      text,
      resultFile: input.resultFile,
      ranBefore: input.ranBefore,
      ...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
      ...(input.tools === true ? { tools: true } : {}),
      shell: allowedShellCommands(candidate.argv),
    });
  if (followup === undefined) {
    return { argv: [...candidate.argv], stdin: stdin(candidate.prompt), resumed: false };
  }

  const previous = followup.previous;
  const reuse: Workspace | undefined =
    previous.cwd !== undefined && (await exists(previous.cwd))
      ? {
          cwd: previous.cwd,
          ...(previous.worktree === undefined ? {} : { worktree: previous.worktree }),
        }
      : undefined;
  const sessionId = previous.sessionId;
  if (reuse !== undefined && sessionId !== undefined && candidate.resume !== undefined) {
    return {
      argv: resumeArgv(candidate.resume, sessionId),
      stdin: stdin(resumeText(followup.messages)),
      resumed: true,
      reuse,
    };
  }
  return {
    argv: [...candidate.argv],
    stdin: stdin(conversationText(candidate.prompt, followup.conversation, followup.messages)),
    resumed: false,
    ...(reuse === undefined ? {} : { reuse }),
  };
}
