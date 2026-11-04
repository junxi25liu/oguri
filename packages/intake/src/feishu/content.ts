/**
 * Feishu message content as plain text (ADR 0030).
 *
 * `im/v1/messages` returns each message's content as a JSON string whose shape
 * depends on `msg_type`. Intake needs only the words a person wrote: `text`
 * and `post` are read, and anything else becomes a short marker so a
 * follow-up that was only an image still shows up in the task thread.
 *
 * Mentions arrive as placeholders (`@_user_1`) resolved through the message's
 * `mentions[]`. The bot's own mention is removed, because "@bot fix the
 * button" is a request to fix the button; any other mention stays as `@name`.
 */

/** One entry of a message's `mentions[]`. */
export interface FeishuMention {
  key: string;
  /** An open_id, or an object of ids in some API versions. */
  id: string | { open_id?: string };
  name?: string;
}

export interface ParsedContent {
  text: string;
  /** The bot was mentioned. */
  mentionsBot: boolean;
}

export function mentionId(mention: FeishuMention): string | undefined {
  return typeof mention.id === "string" ? mention.id : mention.id.open_id;
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A post is `{title, content}`, or the same keyed by locale (`zh_cn`, `en_us`). */
function postBody(content: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(content["content"])) return content;
  for (const value of Object.values(content)) {
    if (
      value !== null &&
      typeof value === "object" &&
      Array.isArray((value as Record<string, unknown>)["content"])
    ) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function postText(post: Record<string, unknown>, mention: (key: string) => string): string {
  const lines: string[] = [];
  const title = post["title"];
  if (typeof title === "string" && title.trim().length > 0) lines.push(title.trim());
  for (const paragraph of post["content"] as unknown[]) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const node of paragraph as unknown[]) {
      if (node === null || typeof node !== "object") continue;
      const element = node as Record<string, unknown>;
      const text = typeof element["text"] === "string" ? element["text"] : "";
      switch (element["tag"]) {
        case "text":
        case "a":
        case "code_block":
        case "md":
          line += text;
          break;
        case "at": {
          const key = element["user_id"];
          line += typeof key === "string" ? mention(key) : "";
          break;
        }
        default:
          // Images, media, emoji: no words to carry.
          break;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Tidy what is left after the bot's mention is removed. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .trim();
}

export function parseContent(
  msgType: string,
  raw: string,
  mentions: readonly FeishuMention[],
  botId: string | undefined,
): ParsedContent {
  let mentionsBot = false;
  const byKey = new Map(mentions.map((m) => [m.key, m]));
  for (const mention of mentions) {
    if (botId !== undefined && mentionId(mention) === botId) mentionsBot = true;
  }
  const mention = (key: string): string => {
    const found = byKey.get(key);
    if (found === undefined) return key;
    if (botId !== undefined && mentionId(found) === botId) return "";
    return `@${found.name ?? mentionId(found) ?? key.replace(/^@_/, "")}`;
  };

  const content = parseJson(raw);
  if (msgType === "text" && typeof content?.["text"] === "string") {
    const text = content["text"].replace(/@_[A-Za-z0-9_]+/g, (key) => mention(key));
    return { text: tidy(text), mentionsBot };
  }
  if (msgType === "post" && content !== null) {
    const post = postBody(content);
    if (post !== null) return { text: tidy(postText(post, mention)), mentionsBot };
  }
  return { text: `[${msgType} message]`, mentionsBot };
}
