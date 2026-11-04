/**
 * Who may start work, and what a chat message is (ADR 0030 §2, §4).
 *
 * Pure and deterministic: the policy, the message, and the task its thread
 * belongs to decide everything. No model is asked, and nothing in the message
 * text can change the answer.
 *
 * - A message in a thread intake already maps to a task is a follow-up, from
 *   any person. It is `admitted` only when its sender could have started the
 *   work; otherwise it is context, which must not resume an ended task.
 * - A message that addresses the bot (a mention in a configured chat, or a
 *   direct message when `direct: true`) from an allowed sender, or from anyone
 *   in a chat with `anyone: true`, is a request.
 * - Everything else is ignored, with the reason.
 */

import { intakePolicyVersion, type IntakeChat, type IntakePolicy } from "@oguri/core";
import type { TaskMandate } from "@oguri/protocol";

import type { InboundMessage } from "./source.ts";
import type { TaskLink } from "./state.ts";

export type Admission =
  | {
      kind: "request";
      room: string;
      target?: string;
      requires?: string[];
      mandate: TaskMandate;
    }
  | { kind: "followup"; taskRef: TaskLink; admitted: boolean }
  | { kind: "ignore"; reason: string };

export const IGNORE_REASONS = {
  notHuman: "not written by a person",
  noSource: "intake.feishu is not configured",
  unknownChat: "not a configured chat",
  notAddressed: "does not address the bot",
  directOff: "direct messages are off (intake.feishu.direct)",
  notAllowed: "sender is not in intake.feishu.allowed",
  empty: "nothing after the mention",
} as const;

/** The chat config a message falls under, if any. */
export function chatFor(
  policy: IntakePolicy,
  conversation: string | undefined,
): IntakeChat | undefined {
  if (conversation === undefined) return undefined;
  return policy.feishu?.chats.find((chat) => chat.id === conversation);
}

export function admit(
  policy: IntakePolicy,
  message: InboundMessage,
  taskRef: TaskLink | undefined,
): Admission {
  const feishu = policy.feishu;
  if (feishu === undefined) return { kind: "ignore", reason: IGNORE_REASONS.noSource };
  if (!message.external.human) return { kind: "ignore", reason: IGNORE_REASONS.notHuman };

  const chat = chatFor(policy, message.external.conversation);
  const allowed = feishu.allowed.includes(message.external.actor);
  const permitted = allowed || chat?.anyone === true;

  if (taskRef !== undefined) return { kind: "followup", taskRef, admitted: permitted };

  if (message.addressed === null) return { kind: "ignore", reason: IGNORE_REASONS.notAddressed };
  if (message.addressed === "direct" && !feishu.direct) {
    return { kind: "ignore", reason: IGNORE_REASONS.directOff };
  }
  // A listed chat is the operator's word about that exact conversation, so its
  // room wins; `directTarget` fills in a direct chat that names no target.
  // `directRoom` covers direct messages from chats nobody listed, which a push
  // source can deliver and the polling Feishu source cannot.
  const direct = message.addressed === "direct";
  const fallbackTarget = direct ? feishu.directTarget : undefined;
  const destination: { room: string; target?: string; requires?: string[] } | undefined =
    chat !== undefined
      ? {
          room: chat.room,
          ...(chat.target === undefined
            ? fallbackTarget === undefined
              ? {}
              : { target: fallbackTarget }
            : { target: chat.target }),
          ...(chat.requires === undefined ? {} : { requires: chat.requires }),
        }
      : direct && feishu.directRoom !== undefined
        ? {
            room: feishu.directRoom,
            ...(fallbackTarget === undefined ? {} : { target: fallbackTarget }),
          }
        : undefined;
  if (destination === undefined) return { kind: "ignore", reason: IGNORE_REASONS.unknownChat };
  if (!permitted) return { kind: "ignore", reason: IGNORE_REASONS.notAllowed };
  if (message.text.trim().length === 0) return { kind: "ignore", reason: IGNORE_REASONS.empty };

  const requires = destination.requires;
  return {
    kind: "request",
    room: destination.room,
    ...(destination.target === undefined ? {} : { target: destination.target }),
    ...(requires === undefined || requires.length === 0 ? {} : { requires: [...requires] }),
    mandate: { strength: "explicit", via: "addressed", policy: intakePolicyVersion(policy) },
  };
}
