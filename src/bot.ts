import { DurableObject } from "cloudflare:workers";
import { HELP_TEXT, parseCommand, type Command } from "./commands";
import { ask, withSources, type ContextLine } from "./llm";
import { isAddressed, stripMention } from "./mentions";
import { ERR, RequestError, type Frame, type Message, type User } from "./protocol";
import { redact, redactDeep } from "./redact";

export interface Env {
  APRON_BOT: DurableObjectNamespace<ApronBot>;
  APRON_URL: string; // wss://server.apron.chat/
  APRON_TOKEN: string; // secret
  OPENROUTER_API_KEY: string; // secret
  ADMIN_TOKEN?: string; // secret; enables /admin/*
  MODEL?: string;
  OWNER_IDS?: string; // comma-separated; default: derived from bot_<owner>
  KEEPALIVE?: string; // "true": stay connected instead of sleeping when idle
  IDLE_SECONDS?: string; // how long to stay connected after activity (default 180)
  PUSH_ENDPOINT?: string; // Web Push endpoint that forwards to /push/<PUSH_SECRET>
  PUSH_SECRET?: string; // secret path segment for /push/<PUSH_SECRET>
}

const AGENT = "chat-agent/0.1";
const PING = '{"method":"ping"}';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING = 6; // the demo closes a socket with > 8 unprocessed frames
const STALE_MS = 140_000;
const CATCHUP_MAX_AGE_MS = 15 * 60_000;
const MAX_CONCURRENT_JOBS = 2;
const MAX_QUEUE = 20;
const MAX_REPLY_CHARS = 8_000;
const USER_HOURLY_LIMIT = 30;
const DENY_NOTICE_EVERY_MS = 6 * 3600_000;
const REMEMBER_IDS = 1000;

interface Persisted {
  checkpoint?: string;
  allow?: string[];
  everyone?: boolean;
  sent?: string[];
  handled?: string[];
  denyNoticed?: Record<string, number>;
  paused?: boolean;
  halted?: string | null;
  costUsd?: number;
  answered?: number;
  pushKeys?: { p256dh: string; auth: string };
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ApronBot extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private connecting = false;
  private me: User | null = null;
  private pending = new Map<string, Pending>();
  private outbox: (() => void)[] = [];
  private counter = 0;
  private lastFrameAt = 0;
  private attempts = 0;
  private historyLock: Promise<unknown> = Promise.resolve();
  private rooms = new Map<string, string | undefined>();
  private jobs: Message[] = [];
  private running = 0;
  private userHits = new Map<string, number[]>();
  private state: Persisted = {};
  private sent = new Set<string>();
  private handled = new Set<string>();
  private loaded: Promise<void>;
  private log: string[] = [];
  private lingerUntil = 0;
  private lastPingAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<Persisted>("state")) ?? {};
      this.log = (await ctx.storage.get<string[]>("log")) ?? [];
      this.sent = new Set(this.state.sent ?? []);
      this.handled = new Set(this.state.handled ?? []);
    });
  }

  // ---------- persistence ----------

  private async save(): Promise<void> {
    this.state.sent = [...this.sent].slice(-REMEMBER_IDS);
    this.state.handled = [...this.handled].slice(-REMEMBER_IDS);
    this.sent = new Set(this.state.sent);
    this.handled = new Set(this.state.handled);
    await this.ctx.storage.put("state", this.state);
  }

  private note(line: string): void {
    const entry = `${new Date().toISOString()} ${redact(line, this.secrets())}`;
    console.log(entry);
    this.log.push(entry);
    if (this.log.length > 100) this.log.shift();
    this.ctx.storage.put("log", this.log).catch(() => {});
  }

  private secrets(): string[] {
    return [this.env.APRON_TOKEN, this.env.OPENROUTER_API_KEY, this.env.ADMIN_TOKEN ?? ""];
  }

  private owners(): Set<string> {
    const ids = (this.env.OWNER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0 && this.me?.user_id.startsWith("bot_")) ids.push(this.me.user_id.slice(4));
    return new Set(ids);
  }

  // ---------- lifecycle ----------
  //
  // An outbound WebSocket keeps the Durable Object awake (and billed), so by
  // default the bot sleeps: it connects when woken (cron poll, a push POST
  // from the Apron server, an admin call), catches up from its checkpoint,
  // answers, stays connected while people are talking to it, then closes the
  // socket and lets its alarm lapse. KEEPALIVE=true keeps it connected.

  private keepAlive(): boolean {
    return /^(1|true|yes)$/i.test(this.env.KEEPALIVE ?? "");
  }

  private idleMs(): number {
    const n = Number(this.env.IDLE_SECONDS);
    return (Number.isFinite(n) && n >= 0 ? n : 180) * 1000;
  }

  /** Stay connected at least `ms` from now. */
  private linger(ms: number): void {
    this.lingerUntil = Math.max(this.lingerUntil, Date.now() + ms);
  }

  private busy(): boolean {
    return this.running > 0 || this.jobs.length > 0 || this.connecting;
  }

  /**
   * Wakes the bot. `poll` (cron) only catches up and goes back to sleep;
   * `push` and `admin` also stay connected for a while for follow-ups.
   */
  async wake(reason: "poll" | "push" | "admin"): Promise<void> {
    await this.loaded;
    if (this.state.paused || this.state.halted) return;
    if (reason !== "poll") {
      this.linger(this.idleMs());
      this.note(`woken (${reason})`);
    }
    if (this.ws && !this.connecting) {
      // Already connected: a push means something new; catch up in case the
      // live delivery raced the wake.
      if (reason === "push") await this.catchUp().catch((e) => this.note(`catch-up failed: ${(e as Error).message}`));
    } else if (!this.connecting) {
      try {
        await this.openSocket();
      } catch (e) {
        this.note(`connect failed (${reason}): ${(e as Error).message}`);
        this.dropSocket();
        if (this.wantsConnection()) await this.scheduleReconnect();
        return;
      }
    }
    await this.settle();
  }

  /** Whether the bot should be connected right now. */
  private wantsConnection(): boolean {
    if (this.state.paused || this.state.halted) return false;
    return this.keepAlive() || this.busy() || Date.now() < this.lingerUntil;
  }

  /** The next alarm: the next ping, or the end of the idle period if sooner. */
  private async tick(): Promise<void> {
    let at = Date.now() + 45_000;
    if (!this.keepAlive() && !this.busy() && this.lingerUntil > Date.now()) at = Math.min(at, this.lingerUntil + 1_000);
    await this.ctx.storage.setAlarm(at);
  }

  /** Closes the socket if nothing needs it, else keeps the ping alarm going. */
  private async settle(): Promise<void> {
    if (!this.ws) return;
    if (this.wantsConnection()) {
      await this.tick();
      return;
    }
    this.note("idle; disconnecting");
    try {
      this.ws.close(1000, "idle");
    } catch {}
    this.dropSocket();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.loaded;
    if (this.state.paused || this.state.halted) return;
    if (this.ws) {
      if (Date.now() - this.lastFrameAt > STALE_MS) {
        this.note("connection stale");
        try {
          this.ws.close(1000, "stale");
        } catch {}
        this.dropSocket();
      } else if (this.wantsConnection()) {
        // Ping on the 45s cadence; an earlier idle-check alarm just reschedules.
        if (Date.now() - this.lastPingAt >= 40_000) {
          try {
            this.ws.send(PING);
            this.lastPingAt = Date.now();
          } catch {}
        }
        await this.tick();
        return;
      } else {
        await this.settle();
        return;
      }
    }
    // Not connected: a reconnect after a drop or failure, if still wanted.
    if (!this.wantsConnection() || this.connecting) return;
    try {
      await this.openSocket();
    } catch (e) {
      this.note(`connect failed: ${(e as Error).message}`);
      this.dropSocket();
      await this.scheduleReconnect();
      return;
    }
    await this.settle();
  }

  private async scheduleReconnect(minSeconds = 0): Promise<void> {
    const delay = Math.max(minSeconds, Math.min(300, 5 * 2 ** this.attempts));
    this.attempts++;
    this.note(`reconnecting in ${delay}s`);
    await this.ctx.storage.setAlarm(Date.now() + delay * 1000);
  }

  private async openSocket(): Promise<void> {
    this.connecting = true;
    try {
      const url = this.env.APRON_URL.replace(/^ws(s?):/, "http$1:");
      const res = await fetch(url, { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`server did not accept the WebSocket (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
      }
      ws.accept();
      this.ws = ws;
      this.lastFrameAt = Date.now();
      ws.addEventListener("message", (event) => {
        this.lastFrameAt = Date.now();
        if (typeof event.data !== "string") return;
        let frame: Frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        this.onFrame(frame).catch((e) => this.note(`frame handler error: ${(e as Error).stack ?? e}`));
      });
      ws.addEventListener("close", (event) => {
        if (this.ws !== ws) return;
        this.onClose(event.code, event.reason).catch(() => {});
      });
      ws.addEventListener("error", () => {
        if (this.ws !== ws) return;
        this.onClose(1006, "error").catch(() => {});
      });

      // auth is a barrier, so it can go before `server` arrives.
      const auth = await this.request("auth", { scheme: "token", token: this.env.APRON_TOKEN, agent: AGENT });
      if (!auth?.you) throw new Error("auth returned no identity");
      this.me = auth.you;
      this.attempts = 0;
      ws.send(PING);
      this.lastPingAt = Date.now();

      const listing = await this.request("room_list", { filter: "joined" });
      for (const room of listing?.joined ?? []) this.rooms.set(room.room_id, room.title);
      await this.registerPush();
      await this.catchUp();
    } catch (e) {
      if (e instanceof RequestError && e.code === ERR.denied) await this.halt(`auth denied: ${e.message}`);
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Registers a Web Push subscription whose endpoint wakes this Worker
   * (PUSH_ENDPOINT, which must be on a push host the server allows). The
   * payload is never decrypted: any POST just means "catch up". Registrations
   * lapse after a week, so this runs on every connection.
   */
  private async registerPush(): Promise<void> {
    const url = this.env.PUSH_ENDPOINT;
    if (!url) return;
    try {
      if (!this.state.pushKeys) {
        const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
        const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
        this.state.pushKeys = { p256dh: b64url(new Uint8Array(raw)), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
        await this.save();
      }
      await this.request("push_register", {
        kind: "webpush",
        url,
        keys: this.state.pushKeys,
        push_id: "chat-agent",
        wake: ["mentions", "replies", "private"],
      });
    } catch (e) {
      this.note(`push_register failed: ${(e as Error).message}`);
    }
  }

  private dropSocket(): void {
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection closed"));
    }
    this.pending.clear();
    this.outbox = [];
  }

  private async onClose(code: number, reason: string): Promise<void> {
    this.note(`connection closed ${code} ${reason}`);
    this.dropSocket();
    // Account changes (token replaced, removed, signed out) are terminal: wait for a human.
    if (code === 1008 && /replaced|removed|signed out|authentication/i.test(reason)) {
      await this.halt(`closed ${code}: ${reason}`);
      return;
    }
    if (this.wantsConnection()) await this.scheduleReconnect(code === 1013 ? 60 : 0);
  }

  private async halt(reason: string): Promise<void> {
    this.note(`halted: ${reason}`);
    this.state.halted = reason;
    await this.save();
    await this.ctx.storage.deleteAlarm();
    try {
      this.ws?.close(1000, "halted");
    } catch {}
    this.dropSocket();
  }

  // ---------- wire ----------

  private send(frame: Frame): void {
    if (!this.ws) throw new Error("not connected");
    // Censor at the lowest layer, except the auth frame, which must carry the token.
    const out = frame.method === "auth" ? frame : redactDeep(frame, this.secrets());
    this.ws.send(JSON.stringify(out));
  }

  private request(method: string, params: unknown, id = `${method}-${Date.now().toString(36)}-${++this.counter}`): Promise<any> {
    return new Promise((resolve, reject) => {
      const go = () => {
        if (!this.ws) return reject(new Error("not connected"));
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
          this.pump();
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        try {
          this.send({ id, method, params });
        } catch (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e as Error);
        }
      };
      if (this.pending.size < MAX_PENDING) go();
      else this.outbox.push(go);
    });
  }

  private pump(): void {
    while (this.outbox.length && this.pending.size < MAX_PENDING) this.outbox.shift()!();
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ method, params });
    } catch {}
  }

  /** One history request at a time per connection; retries retry_after once or twice. */
  private history(params: Record<string, unknown>): Promise<any> {
    const run = async () => {
      for (let i = 0; ; i++) {
        try {
          return await this.request("history", params);
        } catch (e) {
          if (e instanceof RequestError && e.code === ERR.retryAfter && i < 2) {
            await sleep(Math.min(10, e.data?.retry_after ?? 1) * 1000);
            continue;
          }
          throw e;
        }
      }
    };
    const next = this.historyLock.then(run, run);
    this.historyLock = next.catch(() => {});
    return next;
  }

  private async onFrame(frame: Frame): Promise<void> {
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new RequestError(frame.error.code, frame.error.message, frame.error.data));
      else p.resolve(frame.result);
      this.pump();
      return;
    }
    if (frame.error && frame.id === undefined) {
      this.note(`server error ${frame.error.code}: ${frame.error.message}`);
      return; // a close follows if it is fatal
    }
    switch (frame.method) {
      case "message":
        await this.onMessage(frame.params as Message, true);
        break;
      case "room_update": {
        const p = frame.params ?? {};
        for (const r of [...(p.joined ?? []), ...(p.updated ?? [])]) if (r?.room_id) this.rooms.set(r.room_id, r.title);
        for (const r of p.left ?? []) this.rooms.delete(r.room_id);
        for (const m of p.memberships ?? []) this.advance(m.log_id);
        break;
      }
      case "reactions":
        this.advance(frame.params?.log_id);
        break;
      case "user":
        if (frame.params?.you) this.me = { ...this.me!, ...frame.params.you };
        break;
      default:
        break; // ping/pong, activity, status, and unknown notifications
    }
  }

  private advance(logId: string | undefined): void {
    if (!logId || !/^\d+$/.test(logId)) return;
    if (!this.state.checkpoint || Number(logId) > Number(this.state.checkpoint)) this.state.checkpoint = logId;
  }

  // ---------- catch-up ----------

  private async catchUp(): Promise<void> {
    if (!this.state.checkpoint) {
      // First run: start from now, answer nothing old.
      const head = await this.history({ limit: 1 });
      this.state.checkpoint = head?.latest_log_id ?? String(Date.now());
      await this.save();
      return;
    }
    let after = Number(this.state.checkpoint) + 1;
    for (let page = 0; page < 10; page++) {
      const res = await this.history({ after: String(after), limit: 50 });
      for (const msg of res?.messages ?? []) await this.onMessage(msg, false);
      for (const r of res?.rooms ?? []) if (r?.room_id && this.rooms.has(r.room_id)) this.rooms.set(r.room_id, r.title);
      if (res?.last_log_id) this.advance(res.last_log_id);
      if (!res?.more || !res?.last_log_id) break;
      after = Number(res.last_log_id) + 1;
    }
    await this.save();
  }

  // ---------- messages ----------

  private async onMessage(msg: Message, live: boolean): Promise<void> {
    if (!msg?.message_id || !this.me) return; // transient notices
    this.advance(msg.log_id);
    const botId = this.me.user_id;
    if (msg.from?.user_id === botId) {
      this.sent.add(msg.message_id);
      return;
    }
    if (msg.log_id && msg.log_id !== msg.message_id) return save(this); // an edit, not a new message
    if (!isAddressed(msg, botId, this.sent)) return save(this);
    if (this.handled.has(msg.message_id)) return;
    this.handled.add(msg.message_id);
    if (!live && Date.now() - Number(msg.message_id) > CATCHUP_MAX_AGE_MS) return save(this);
    await this.save();

    if (this.jobs.length >= MAX_QUEUE) {
      this.note(`queue full; dropping ${msg.message_id}`);
      return;
    }
    // Acknowledge right away on a live mention.
    if (live && this.isAuthorized(msg.from.user_id)) {
      this.request("reactions", { message_id: msg.message_id, emojis: ["👀"] }).catch(() => {});
    }
    this.linger(this.idleMs());
    this.jobs.push(msg);
    this.drain();

    function save(self: ApronBot) {
      // Persist the checkpoint for every message; cheap on SQLite storage.
      return self.ctx.storage.put("state", self.state);
    }
  }

  private isAuthorized(userId: string): boolean {
    return this.owners().has(userId) || !!this.state.everyone || (this.state.allow ?? []).includes(userId);
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT_JOBS && this.jobs.length) {
      const msg = this.jobs.shift()!;
      this.running++;
      this.ctx.waitUntil(
        this.handle(msg)
          .catch((e) => this.note(`job ${msg.message_id} failed: ${(e as Error).stack ?? e}`))
          .finally(() => {
            this.running--;
            this.drain();
            this.linger(this.idleMs());
            this.settle().catch(() => {});
          }),
      );
    }
  }

  private async reply(to: Message, text: string, key: string): Promise<void> {
    let body = text.trim() || "(no answer)";
    if (body.length > MAX_REPLY_CHARS) body = `${body.slice(0, MAX_REPLY_CHARS)}\n\n…(truncated)`;
    const params = {
      room_id: to.room_id,
      reply_to: { message_id: to.message_id },
      body: { text: body, format: "markdown" },
    };
    // A deterministic id makes a retry of the same reply a no-op on the server.
    const id = `${key}-${to.message_id}`;
    for (let i = 0; ; i++) {
      try {
        const res = await this.request("message", params, id);
        if (res?.message_id) {
          this.sent.add(res.message_id);
          await this.save();
        }
        return;
      } catch (e) {
        const wait = e instanceof RequestError && e.code === ERR.retryAfter ? (e.data?.retry_after ?? 5) : 3;
        if (i >= 2 || (e instanceof RequestError && e.code !== ERR.retryAfter)) throw e;
        await sleep(Math.min(30, wait) * 1000);
      }
    }
  }

  private async handle(msg: Message): Promise<void> {
    const me = this.me!;
    const from = msg.from.user_id;
    const owner = this.owners().has(from);
    const text = stripMention(msg.body?.text ?? "", me.user_id);
    const mentions = (msg.body?.mentions ?? []).filter((id) => id !== me.user_id);

    const command = parseCommand(text, mentions);
    if (command) {
      if (owner) return this.reply(msg, await this.runCommand(command, msg), "cmd");
      if (this.isAuthorized(from)) return this.reply(msg, "Only my owner can do that.", "cmd");
    }

    if (!this.isAuthorized(from)) {
      const last = this.state.denyNoticed?.[from] ?? 0;
      if (Date.now() - last < DENY_NOTICE_EVERY_MS) return;
      this.state.denyNoticed = { ...(this.state.denyNoticed ?? {}), [from]: Date.now() };
      await this.save();
      const ownerList = [...this.owners()].map((o) => `@${o}`).join(", ");
      return this.reply(msg, `Sorry, I only answer people on my allowlist.${ownerList ? ` Ask ${ownerList} to add you.` : ""}`, "deny");
    }

    if (!owner && !this.takeQuota(from)) {
      return this.reply(msg, "You've hit my hourly question limit; try again later.", "limit");
    }

    const stopTyping = this.typing(msg.room_id);
    try {
      const context = await this.contextFor(msg);
      const answer = await ask({
        apiKey: this.env.OPENROUTER_API_KEY,
        model: this.env.MODEL || "anthropic/claude-sonnet-5.5",
        botName: me.name || me.user_id,
        question: text,
        asker: who(msg.from),
        roomTitle: msg.room_id ? this.rooms.get(msg.room_id) : undefined,
        context,
      });
      this.state.costUsd = (this.state.costUsd ?? 0) + answer.costUsd;
      this.state.answered = (this.state.answered ?? 0) + 1;
      this.note(`answered ${msg.message_id} for ${from} ($${answer.costUsd.toFixed(4)})`);
      stopTyping();
      await this.reply(msg, withSources(answer), "ans");
    } catch (e) {
      stopTyping();
      this.note(`answer failed for ${msg.message_id}: ${(e as Error).message}`);
      const out = /402|credit|limit/i.test((e as Error).message)
        ? "Sorry, I'm out of model credits right now."
        : "Sorry, something went wrong while answering. Try again in a bit.";
      await this.reply(msg, out, "ans");
    }
  }

  private takeQuota(userId: string): boolean {
    const now = Date.now();
    const hits = (this.userHits.get(userId) ?? []).filter((t) => now - t < 3600_000);
    if (hits.length >= USER_HOURLY_LIMIT) return false;
    hits.push(now);
    this.userHits.set(userId, hits);
    return true;
  }

  /** Shows the bot as typing until the returned function is called. */
  private typing(roomId: string | undefined): () => void {
    if (!roomId) return () => {};
    this.notify("activity", { room_id: roomId, typing: 15 });
    const timer = setInterval(() => this.notify("activity", { room_id: roomId, typing: 15 }), 12_000);
    return () => clearInterval(timer);
  }

  private async contextFor(msg: Message): Promise<ContextLine[]> {
    const lines: ContextLine[] = [];
    const botId = this.me!.user_id;
    try {
      if (msg.room_id && msg.log_id) {
        const res = await this.history({ room_id: msg.room_id, before: String(Number(msg.log_id) - 1), limit: 30 });
        const latest = new Map<string, Message>();
        for (const m of res?.messages ?? []) if (m.message_id && !m.deleted && m.body?.text) latest.set(m.message_id, m);
        for (const m of [...latest.values()].slice(-12)) {
          lines.push({ from: who(m.from), text: clip(m.body!.text!, 1500), bot: m.from.user_id === botId });
        }
        const target = msg.reply_to?.message_id;
        if (target && !latest.has(target)) {
          const r = await this.history({ after: target, before: target, limit: 1 });
          const m: Message | undefined = (r?.messages ?? []).find((x: Message) => x.message_id === target);
          if (m?.body?.text) lines.unshift({ from: `${who(m.from)} (the message being replied to)`, text: clip(m.body.text, 3000), bot: m.from.user_id === botId });
        }
      }
    } catch (e) {
      this.note(`context fetch failed: ${(e as Error).message}`);
    }
    return lines;
  }

  private async runCommand(cmd: Command, msg: Message): Promise<string> {
    const allow = new Set(this.state.allow ?? []);
    switch (cmd.kind) {
      case "help":
        return HELP_TEXT;
      case "list": {
        const people = [...allow].map((u) => `@${u}`).join(", ") || "nobody";
        const ownerList = [...this.owners()].map((o) => `@${o}`).join(", ");
        return `${this.state.everyone ? "**Everyone** may use me. " : ""}Allowlist: ${people}. Owner: ${ownerList}.`;
      }
      case "allow":
      case "deny": {
        const users = cmd.users.filter((u) => u !== this.me!.user_id);
        for (const u of users) cmd.kind === "allow" ? allow.add(u) : allow.delete(u);
        if (cmd.everyone) this.state.everyone = cmd.kind === "allow";
        this.state.allow = [...allow];
        await this.save();
        const parts: string[] = [];
        if (users.length) parts.push(`${cmd.kind === "allow" ? "Added" : "Removed"} ${users.map((u) => `@${u}`).join(", ")}.`);
        if (cmd.everyone) parts.push(cmd.kind === "allow" ? "Everyone may use me now." : "Only the allowlist may use me now.");
        return parts.join(" ") || "Nothing changed.";
      }
      case "join":
      case "leave": {
        const roomId = cmd.roomId ?? msg.room_id;
        if (!roomId) return "Which room?";
        try {
          await this.request(cmd.kind === "join" ? "room_join" : "room_leave", { room_id: roomId });
          if (cmd.kind === "leave") this.rooms.delete(roomId);
          return cmd.kind === "join" ? `Joined \`${roomId}\`.` : `Left \`${roomId}\`.`;
        } catch (e) {
          return `Couldn't ${cmd.kind} \`${roomId}\`: ${(e as Error).message}`;
        }
      }
    }
  }

  // ---------- HTTP (admin) ----------

  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/admin/, "");
    switch (`${request.method} ${path}`) {
      case "GET /health":
        return json({ connected: !!this.ws && !!this.me, halted: !!this.state.halted, paused: !!this.state.paused });
      case "POST /wake":
        await this.wake("admin");
        return json({ connected: !!this.ws });
      case "GET /status":
        return json({
          connected: !!this.ws,
          mode: this.keepAlive() ? "keepalive" : "sleep when idle",
          lingerUntil: this.lingerUntil > Date.now() ? new Date(this.lingerUntil).toISOString() : null,
          push: this.env.PUSH_ENDPOINT ? "registered on each connection" : "off (set PUSH_ENDPOINT)",
          me: this.me,
          owners: [...this.owners()],
          allow: this.state.allow ?? [],
          everyone: !!this.state.everyone,
          rooms: Object.fromEntries(this.rooms),
          paused: !!this.state.paused,
          halted: this.state.halted ?? null,
          checkpoint: this.state.checkpoint,
          answered: this.state.answered ?? 0,
          costUsd: this.state.costUsd ?? 0,
          queue: this.jobs.length,
          running: this.running,
          log: this.log.slice(-30),
        });
      case "POST /allow":
      case "POST /deny": {
        const user = url.searchParams.get("user");
        if (!user) return json({ error: "user required" }, 400);
        const allow = new Set(this.state.allow ?? []);
        if (user === "*") this.state.everyone = path === "/allow";
        else path === "/allow" ? allow.add(user) : allow.delete(user);
        this.state.allow = [...allow];
        await this.save();
        return json({ allow: this.state.allow, everyone: !!this.state.everyone });
      }
      case "POST /pause":
        this.state.paused = true;
        await this.save();
        await this.ctx.storage.deleteAlarm();
        try {
          this.ws?.close(1000, "paused");
        } catch {}
        this.dropSocket();
        return json({ paused: true });
      case "POST /resume":
        this.state.paused = false;
        this.state.halted = null;
        this.attempts = 0;
        await this.save();
        await this.wake("admin");
        return json({ resumed: true, connected: !!this.ws });
      default:
        return json({ error: "not found" }, 404);
    }
  }
}

function who(u: User): string {
  return u.name && u.name !== u.user_id ? `${u.name} (@${u.user_id})` : `@${u.user_id}`;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
}
