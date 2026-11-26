import { ApronBot, type Env } from "./bot";

export { ApronBot };

function stub(env: Env) {
  return env.APRON_BOT.get(env.APRON_BOT.idFromName("main"));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return stub(env).fetch(new Request(new URL("/health", url), { method: "GET" }));
    }
    // Web Push wake: the Apron server (or a relay in front of us) POSTs here
    // when the bot is mentioned or replied to. The payload is not needed.
    if (url.pathname.startsWith("/push/") && request.method === "POST") {
      const secret = url.pathname.slice("/push/".length);
      if (!env.PUSH_SECRET || !timingSafeEqual(secret, env.PUSH_SECRET)) return new Response("not found", { status: 404 });
      ctx.waitUntil(stub(env).wake("push"));
      return new Response(null, { status: 201 });
    }
    if (url.pathname.startsWith("/admin/")) {
      const auth = request.headers.get("authorization") ?? "";
      if (!env.ADMIN_TOKEN || !timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      return stub(env).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },

  // Polls: connect, catch up from the checkpoint, answer, sleep again.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await stub(env).wake("poll");
  },
} satisfies ExportedHandler<Env>;
