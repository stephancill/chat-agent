// Owner commands, written after the bot's mention: `@bot allow @alice`.

export type Command =
  | { kind: "help" }
  | { kind: "allow"; users: string[]; everyone: boolean }
  | { kind: "deny"; users: string[]; everyone: boolean }
  | { kind: "list" }
  | { kind: "join"; roomId: string | null }
  | { kind: "leave"; roomId: string | null };

const USER_TOKEN = /^@?([^\s@,;]+)$/;
const EVERYONE = new Set(["everyone", "*", "all", "@everyone"]);

/**
 * Parses `text` (with the bot mention already stripped) as an owner command, or
 * returns null for anything else, which is a question. `mentions` is the
 * message's `body.mentions`, minus the bot.
 */
export function parseCommand(text: string, mentions: string[]): Command | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const verb = words[0].toLowerCase().replace(/^\//, "");
  const args = words.slice(1);

  switch (verb) {
    case "help":
      return args.length === 0 ? { kind: "help" } : null;
    case "allowlist":
    case "whitelist":
      return args.length === 0 || (args.length === 1 && args[0].toLowerCase() === "list") ? { kind: "list" } : null;
    case "allow":
    case "deny":
    case "disallow":
    case "remove": {
      if (args.length === 0) return null;
      const users = new Set<string>(mentions);
      let everyone = false;
      for (const arg of args) {
        if (EVERYONE.has(arg.toLowerCase())) {
          everyone = true;
          continue;
        }
        const m = USER_TOKEN.exec(arg);
        // Anything that isn't a user token means this is prose, not a command.
        if (!m) return null;
        users.add(m[1]);
      }
      // "allow me to ..." and the like are questions, not commands.
      if (!everyone && mentions.length === 0 && args.length > 3) return null;
      const kind = verb === "allow" ? "allow" : "deny";
      return { kind, users: [...users], everyone };
    }
    case "join":
    case "leave":
      if (args.length > 1) return null;
      return { kind: verb, roomId: args[0] ?? null };
    default:
      return null;
  }
}

export const HELP_TEXT = [
  "Mention me with a question and I'll search the web and answer. Owner commands:",
  "",
  "- `allow @user …` — let users ask me questions (`allow everyone` opens me to all)",
  "- `deny @user …` — remove users (`deny everyone` closes me again)",
  "- `allowlist` — show who may use me",
  "- `join <room_id>` / `leave [room_id]` — join or leave a room",
].join("\n");
