import type { Message } from "./protocol";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word-boundary `@user_id` token, so `@bot_a` does not match `@bot_ab` or `x@bot_a`. */
export function mentionPattern(userId: string, flags = "i"): RegExp {
  return new RegExp(`(^|[^\\w@/.-])@${escapeRegExp(userId)}(?![\\w-])`, flags);
}

/**
 * Whether `msg` is addressed to the bot: its user_id is in `body.mentions`, the
 * text has a word-boundary `@user_id`, or it replies to one of the bot's own
 * messages. Display names never count. The bot's own messages never count.
 */
export function isAddressed(msg: Message, botId: string, sentIds: { has(id: string): boolean }): boolean {
  if (!msg.body || msg.deleted) return false;
  if (msg.from?.user_id === botId) return false;
  if (msg.body.mentions?.includes(botId)) return true;
  if (msg.body.text && mentionPattern(botId).test(msg.body.text)) return true;
  const replyTo = msg.reply_to;
  if (replyTo) {
    if (replyTo.from?.user_id === botId) return true;
    if (replyTo.message_id && sentIds.has(replyTo.message_id)) return true;
  }
  return false;
}

/** The text with every `@botId` mention removed and whitespace tidied. */
export function stripMention(text: string, botId: string): string {
  return text
    .replace(mentionPattern(botId, "gi"), "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}
