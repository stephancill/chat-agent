# chat-agent: an Apron search bot

An [Apron](https://apron.chat/protocol) chat bot you `@mention` with a question.
It searches the web, reads pages, and replies in a thread to your message, with
sources. Runs on Cloudflare Workers: one Durable Object holds the bot's single
WebSocket to the Apron server.

## Sleeping when idle

Durable Objects only hibernate on WebSockets they *receive*; an outbound socket
keeps the object awake and billed. So by default the bot sleeps:

- **Wake** on the cron poll (every 2 minutes), on a Web Push POST to
  `/push/<PUSH_SECRET>`, or on `POST /admin/wake`.
- On waking it connects, catches up from its last log position (answering
  mentions under 15 minutes old), and answers.
- It stays connected for `IDLE_SECONDS` (default 180) after the last mention or
  answer, so follow-ups are instant, then closes the socket and lets its alarm
  lapse.
- **Push** (optional): set `PUSH_ENDPOINT` to a Web Push endpoint on a host the
  Apron server allows that forwards POSTs to `/push/<PUSH_SECRET>`. The bot
  registers it on every connection (`push_register`, waking on mentions,
  replies and private rooms) and never decrypts the payload. The server waits
  30 seconds before pushing. Without push, answers take up to one poll interval.
- `KEEPALIVE=true` keeps it connected all the time instead.

## Using it

- Mention it (`@bot_<owner>`, by user ID; display names don't count) or reply to
  one of its messages. It reacts 👀, shows typing, then replies.
- It sees the last ~12 messages of the room (and the message you replied to), so
  follow-ups work.
- It answers only its owner and people on its allowlist. Anyone else gets one
  short notice (at most every 6 hours per person).

### Owner commands

The owner is `<owner>` for a bot token from `/invite-bot` (`bot_<owner>`), or
`OWNER_IDS` (comma-separated) if set. Mention the bot, then:

| Command | Effect |
| --- | --- |
| `allow @user …` | Let users ask questions. `allow everyone` opens it to all. |
| `deny @user …` | Remove users. `deny everyone` closes it again. |
| `allowlist` | Show who may use it. |
| `join <room_id>` / `leave [room_id]` | Join or leave a room. You can also add the bot to a room yourself. |
| `help` | List commands. |

The bot only hears rooms it has joined (on the demo server, add it with your
client, or `join <room_id>`).

### Admin HTTP API

With the `ADMIN_TOKEN` secret set, `Authorization: Bearer <ADMIN_TOKEN>`:

- `GET /admin/status` — connection, allowlist, rooms, spend, recent log
- `POST /admin/allow?user=<id>` / `POST /admin/deny?user=<id>` (`user=*` for everyone)
- `POST /admin/wake` — connect now and stay for `IDLE_SECONDS`
- `POST /admin/pause` (kill switch) / `POST /admin/resume` (also clears a halt after a token problem)

`GET /health` is public.

## Behaviour

- While connected, pings at the server's interval and reconnects with backoff; a denied sign-in or a
  "token replaced" close halts it until `/admin/resume`.
- On reconnect it catches up from its last log position and answers mentions
  under 15 minutes old. Each message is answered once (dedup by message ID, and
  deterministic request IDs, so the server drops retried replies).
- Ignores edits, its own messages, display-name mentions.
- Token-like strings are redacted from everything it sends.
- Limits: 2 answers at a time, 20 queued, 30 questions an hour per non-owner,
  replies capped at 8,000 characters.

## Configuration

`wrangler.toml` vars: `APRON_URL` (default `wss://server.apron.chat/`), `MODEL`
(default `anthropic/claude-sonnet-5.5` on OpenRouter), `OWNER_IDS`,
`IDLE_SECONDS`, `KEEPALIVE`, `PUSH_ENDPOINT` (all optional).

Secrets: `APRON_TOKEN` (from `/invite-bot`), `OPENROUTER_API_KEY`, `ADMIN_TOKEN`,
`PUSH_SECRET` (with push).

Web search uses OpenRouter's `openrouter:web_search` server tool; `fetch_url`
runs in the Worker.

## Development

```sh
npm install
npm test          # unit tests (bun)
npm run typecheck
cp .dev.vars.example .dev.vars   # fill in
npm run dev
```

To test end to end, run [apron-server-cloudflare](https://github.com/apron-chat/apron-server-cloudflare)
locally with `--var APRON_ADMIN_TOKEN:…`, `/invite-token alice` as the admin,
then `/invite-bot` as alice. Workers strip `CF-Connecting-IP` on subrequests,
which that server requires, so put a small relay in front of it that adds the
header.

## Deploying

With wrangler: `npx wrangler secret put …` for each secret, then `npm run deploy`.

Through [stupid vault](https://github.com/stephancill/stupid-vault) (each API call
approved in the app):

```sh
npm run build
APRON_TOKEN=… OPENROUTER_API_KEY=… ADMIN_TOKEN=… \
  python3 scripts/vault_deploy.py --account <account_id> --vault-skill <stupid-vault>/skills/stupid-vault
```

Secrets left unset keep their deployed values. On redeploys pass
`--deployed-tag <last applied migration tag>` (currently `v1`).
