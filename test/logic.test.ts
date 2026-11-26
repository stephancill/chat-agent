import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/commands";
import { htmlToText, withSources } from "../src/llm";
import { isAddressed, stripMention } from "../src/mentions";
import type { Message } from "../src/protocol";
import { redact, redactDeep } from "../src/redact";

const BOT = "bot_alice";
const none = new Set<string>();
const msg = (text: string, extra: Partial<Message> = {}): Message => ({
  message_id: "1",
  log_id: "1",
  room_id: "general",
  from: { user_id: "bob", name: "Bob" },
  body: { text },
  ...extra,
});

describe("isAddressed", () => {
  test("structured mention", () => {
    expect(isAddressed(msg("hey", { body: { text: "hey", mentions: [BOT] } }), BOT, none)).toBe(true);
  });
  test("word-boundary @user_id in text", () => {
    expect(isAddressed(msg("@bot_alice what is up"), BOT, none)).toBe(true);
    expect(isAddressed(msg("hi @bot_alice, what?"), BOT, none)).toBe(true);
    expect(isAddressed(msg("hi @BOT_ALICE"), BOT, none)).toBe(true);
  });
  test("no partial or embedded matches", () => {
    expect(isAddressed(msg("@bot_alicex hi"), BOT, none)).toBe(false);
    expect(isAddressed(msg("@bot_alice-2 hi"), BOT, none)).toBe(false);
    expect(isAddressed(msg("mail me@bot_alice"), BOT, none)).toBe(false);
    expect(isAddressed(msg("see https://x.com/@bot_alice"), BOT, none)).toBe(false);
  });
  test("display name and bare name do not count", () => {
    expect(isAddressed(msg("Bot of alice, hi"), BOT, none)).toBe(false);
    expect(isAddressed(msg("bot_alice hi"), BOT, none)).toBe(false);
  });
  test("reply to one of the bot's messages", () => {
    expect(isAddressed(msg("and?", { reply_to: { message_id: "9" } }), BOT, new Set(["9"]))).toBe(true);
    expect(isAddressed(msg("and?", { reply_to: { message_id: "9", from: { user_id: BOT } } }), BOT, none)).toBe(true);
    expect(isAddressed(msg("and?", { reply_to: { message_id: "8" } }), BOT, new Set(["9"]))).toBe(false);
  });
  test("never its own messages, or deleted ones", () => {
    expect(isAddressed(msg("@bot_alice", { from: { user_id: BOT } }), BOT, none)).toBe(false);
    expect(isAddressed(msg("@bot_alice", { deleted: true }), BOT, none)).toBe(false);
  });
});

describe("stripMention", () => {
  test("removes the mention", () => {
    expect(stripMention("@bot_alice what is bun?", BOT)).toBe("what is bun?");
    expect(stripMention("so @bot_alice, why", BOT)).toBe("so , why");
  });
});

describe("parseCommand", () => {
  test("allow with mentions and bare ids", () => {
    expect(parseCommand("allow @carol", ["carol"])).toEqual({ kind: "allow", users: ["carol"], everyone: false });
    expect(parseCommand("allow dave_1 @erin", [])).toEqual({ kind: "allow", users: ["dave_1", "erin"], everyone: false });
    expect(parseCommand("allow everyone", [])).toEqual({ kind: "allow", users: [], everyone: true });
  });
  test("deny", () => {
    expect(parseCommand("deny @carol", ["carol"])).toEqual({ kind: "deny", users: ["carol"], everyone: false });
    expect(parseCommand("remove carol", [])).toEqual({ kind: "deny", users: ["carol"], everyone: false });
  });
  test("questions are not commands", () => {
    expect(parseCommand("allow me to ask: what is the capital of France?", [])).toBeNull();
    expect(parseCommand("what is the weather", [])).toBeNull();
    expect(parseCommand("help me find a restaurant", [])).toBeNull();
    expect(parseCommand("allow", [])).toBeNull();
    expect(parseCommand("join the dots for me please", [])).toBeNull();
  });
  test("list, help, join, leave", () => {
    expect(parseCommand("allowlist", [])).toEqual({ kind: "list" });
    expect(parseCommand("help", [])).toEqual({ kind: "help" });
    expect(parseCommand("join 1793555674934", [])).toEqual({ kind: "join", roomId: "1793555674934" });
    expect(parseCommand("leave", [])).toEqual({ kind: "leave", roomId: null });
  });
});

describe("redact", () => {
  test("token-like strings", () => {
    expect(redact("x apron_bot_FAKEfakeFAKEfake1234 y")).toBe("x [redacted] y");
    expect(redact("key sk-or-v1-0000aaaa1111bbbb2222cc")).toBe("key [redacted]");
    expect(redact("my secret is hunter2hunter2", ["hunter2hunter2"])).toBe("my secret is [redacted]");
  });
  test("deep", () => {
    expect(redactDeep({ a: ["apron_invite_aaaaaaaaaaaa"], b: 1 })).toEqual({ a: ["[redacted]"], b: 1 });
  });
});

describe("llm helpers", () => {
  test("htmlToText", () => {
    expect(htmlToText("<html><head><title>x</title></head><body><script>bad()</script><p>Hello &amp; bye</p></body></html>")).toBe("Hello & bye");
  });
  test("withSources appends only missing links", () => {
    const out = withSources({ text: "See [a](https://a.com).", sources: [{ url: "https://a.com" }, { url: "https://b.com/x", title: "B" }], costUsd: 0 });
    expect(out).toBe("See [a](https://a.com).\n\n**Sources**\n- [B](https://b.com/x)");
  });
});
