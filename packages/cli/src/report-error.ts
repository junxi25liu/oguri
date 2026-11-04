import {
  AmbiguousIdentityError,
  ApprovalRequiredError,
  IdentityMismatchError,
  SecretDetectedError,
  describeError,
  describeFindings,
} from "@oguri/core";

import { UsageError } from "./context.ts";
import { dim, errline, red, yellow } from "./output.ts";

/**
 * Turn a thrown error into a user-facing message and an exit code.
 *
 * Exit codes are part of the contract with agents that drive the CLI: 2 usage,
 * 4 a person must approve, 6 identity was not asserted, 1 everything else.
 */
export function reportError(error: unknown): number {
  if (error instanceof UsageError) return 2;

  // The scanner block must read the same whether it came from this process or
  // across the socket, where only message and code survive.
  const code = (error as { code?: unknown } | null)?.code;

  // A daemon started before this CLI was installed does not know its newer
  // IPC methods. Untranslated, that surfaces as "unknown method handshake",
  // which reads like a typo in the command rather than a stale process.
  if (code === "UNKNOWN_METHOD") {
    errline(red("✗ the running oguri daemon is older than this CLI"));
    errline("  It does not know this command yet. Restart it:");
    errline(dim("    oguri daemon stop && oguri daemon start"));
    errline("");
    errline(dim("  Or run this one command without it: --direct"));
    return 1;
  }
  // Exit 4, distinct from a generic failure: an agent driving the CLI must be
  // able to tell "your human has to see this" from "the command was wrong",
  // without parsing prose.
  if (
    error instanceof IdentityMismatchError ||
    error instanceof AmbiguousIdentityError ||
    code === "IDENTITY_MISMATCH" ||
    code === "AMBIGUOUS_IDENTITY"
  ) {
    errline(red("✗ refusing to act as an identity that was not asserted"));
    if (error instanceof Error) errline(`  ${error.message}`);
    errline("");
    errline(dim("  who this machine holds:  oguri agent list"));
    errline(dim("  who you would be here:   oguri status"));
    return 6;
  }
  if (error instanceof ApprovalRequiredError || code === "APPROVAL_REQUIRED") {
    errline(yellow("✗ this work needs a person's approval before you take it on"));
    if (error instanceof Error) errline(`  ${error.message}`);
    errline("");
    errline("Show your human who is asking and what the work touches. If they agree:");
    errline(
      dim(
        error instanceof ApprovalRequiredError
          ? `  oguri ${error.kind} approve ${error.room} ${error.id}`
          : "  oguri task approve <room> <id>",
      ),
    );
    errline(dim("Current rules: oguri policy"));
    return 4;
  }
  if (error instanceof SecretDetectedError || code === "SECRET_DETECTED") {
    errline(red("✗ refused to send — possible secret detected"));
    if (error instanceof SecretDetectedError) {
      errline(`  ${describeFindings(error.findings)}`);
    } else if (error instanceof Error) {
      errline(`  ${error.message}`);
    }
    errline("");
    errline("Git history is permanent: a leaked credential can only be rotated, not recalled.");
    errline("Remove it, or if this is a false positive:");
    errline(dim("  oguri send ... --force-unsafe '<why this is safe>'"));
    return 1;
  }

  // The task graph's refusals each call for a different next move, so the code
  // is printed where an agent reading stderr can match it without parsing prose.
  if (
    code === "DEPENDENCY_PENDING" ||
    code === "ATTEMPTS_EXHAUSTED" ||
    code === "CAPABILITY_MISSING"
  ) {
    errline(red(`error [${code}]: ${describeError(error)}`));
    return 1;
  }

  errline(red(`error: ${describeError(error)}`));
  return 1;
}
