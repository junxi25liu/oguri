import { type ReviewTaskStatus } from "@oguri/core";
import {
  type Message,
  REVIEW_TASK_STATES,
  assertAgentId,
  assertRoomId,
  isReviewTaskState,
} from "@oguri/protocol";
import { bold, cyan, dim, green, json, messageToJson, out, red } from "../output.ts";

import { cmdApprove } from "./approvals.ts";
import { type Ctx, bool, list, str, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdReview(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === undefined) {
    usage("review needs a subcommand: request, update, approve, or list");
  }

  if (sub === "approve") return await cmdApprove(ctx, "review");

  const room = ctx.positionals[2];
  if (room === undefined) {
    usage("review needs a room: review request|update|list <room>");
  }
  assertRoomId(room);

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "request": {
        const reviewer = str(ctx, "reviewer");
        const repo = str(ctx, "repo");
        const baseRev = str(ctx, "base");
        const headRev = str(ctx, "head");
        const summary = ctx.positionals.slice(3).join(" ");
        if (
          reviewer === undefined ||
          repo === undefined ||
          baseRev === undefined ||
          headRev === undefined ||
          summary === ""
        ) {
          usage(
            "review request needs text plus --reviewer <agent> --repo <host/owner/repo> --base <sha> --head <sha>",
          );
        }
        assertAgentId(reviewer);
        const deadline = str(ctx, "deadline");
        const message = await be.call<Message>("reviewRequest", {
          room,
          input: {
            reviewer,
            repo,
            baseRev,
            headRev,
            summary,
            ...(list(ctx, "scope").length === 0 ? {} : { scope: list(ctx, "scope") }),
            ...(deadline === undefined ? {} : { deadline }),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else {
          out(green("✓ review requested") + dim(` ${message.header.review?.id ?? ""}`));
          out(dim(`  ${repo}@${headRev.slice(0, 12)} → ${reviewer}`));
        }
        return 0;
      }
      case "update": {
        const reviewId = ctx.positionals[3];
        const state = ctx.positionals[4];
        const body = ctx.positionals.slice(5).join(" ");
        if (reviewId === undefined || !isReviewTaskState(state) || body === "") {
          usage(
            `review update needs <review-id> <state> <text>; state is one of: ${REVIEW_TASK_STATES.join(", ")}`,
          );
        }
        const message = await be.call<Message>("reviewUpdate", {
          room,
          reviewId,
          input: {
            state,
            body,
            ...(list(ctx, "ref").length === 0 ? {} : { refs: list(ctx, "ref") }),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else out(green(`✓ review ${reviewId} → ${state}`) + dim(` ${message.header.id}`));
        return 0;
      }
      case "list": {
        const reviews = await be.call<ReviewTaskStatus[]>("reviews", { room });
        if (bool(ctx, "json")) {
          json(reviews);
          return 0;
        }
        if (reviews.length === 0) {
          out(dim(`no review tasks in ${room}`));
          return 0;
        }
        for (const status of reviews) {
          const r = status.review;
          const conflicts =
            status.invalidEvents.length === 0
              ? ""
              : red(` · ${String(status.invalidEvents.length)} invalid event(s)`);
          out(
            `${bold(r.id)}  ${cyan(r.state.padEnd(11))} ${r.repo}@${r.headRev.slice(0, 12)} → ${r.reviewer}${conflicts}`,
          );
        }
        return 0;
      }
      default:
        usage("unknown review subcommand; use request, update, prepare, release, approve, or list");
    }
  });
}
