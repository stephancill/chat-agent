// Censors token-like strings in everything the bot sends, at the lowest layer.

const PATTERNS = [
  /apron_(?:bot|invite|join|device|session)_[A-Za-z0-9_-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /sk-(?:ant|proj)-[A-Za-z0-9_-]{16,}/g,
];

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** Redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T, secrets: string[] = []): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out as T;
  }
  return value;
}
