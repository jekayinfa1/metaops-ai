import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Application secret (session HMAC + token-encryption keying material).
 *
 * Local development may run without METAOPS_SECRET and falls back to the
 * built-in, obviously-labelled DEVELOPMENT secret below. That fallback is a
 * known public value: anyone can forge sessions for an instance using it.
 * Production therefore FAILS CLOSED — assertSecretConfiguration() refuses to
 * boot when NODE_ENV=production and the secret is missing, is a known
 * development/default value, or is shorter than MIN_PRODUCTION_SECRET_LENGTH.
 * No predictable substitute is ever generated.
 */
export const DEV_FALLBACK_SECRET = "metaops-local-dev-secret-change-me";
const INSECURE_SECRETS = new Set([
  DEV_FALLBACK_SECRET, "change-me", "secret", "password", "dev-secret", "metaops-secret", "test-secret"
]);
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

export function secretConfigurationError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production") return null;
  const s = env.METAOPS_SECRET;
  if (!s) return "METAOPS_SECRET is not set: production refuses to boot with the built-in local development secret. Generate a long random value (e.g. `openssl rand -hex 32`) and set METAOPS_SECRET in the server environment.";
  if (INSECURE_SECRETS.has(s)) return "METAOPS_SECRET is a known development/default value: production refuses to boot with it. Set METAOPS_SECRET to a long random value that exists nowhere in this repository.";
  if (s.length < MIN_PRODUCTION_SECRET_LENGTH) return `METAOPS_SECRET is too short (${s.length} characters): production requires at least ${MIN_PRODUCTION_SECRET_LENGTH}. Set METAOPS_SECRET to a long random value (e.g. \`openssl rand -hex 32\`).`;
  return null;
}
export function assertSecretConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const err = secretConfigurationError(env);
  if (err) throw new Error(err);
}
export const SECRET_SOURCE: "env" | "dev-fallback" = process.env.METAOPS_SECRET ? "env" : "dev-fallback";

const SECRET = process.env.METAOPS_SECRET || DEV_FALLBACK_SECRET;
export const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const randomToken = (n = 32) => randomBytes(n).toString("base64url");

// scrypt parameters are explicit and FIXED: stored hashes embed no parameter
// block, so changing these values would invalidate every existing password.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pw, salt, 64, SCRYPT_PARAMS).toString("hex");
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const h = scryptSync(pw, Buffer.from(saltHex, "hex"), 64, SCRYPT_PARAMS);
  const e = Buffer.from(hashHex, "hex");
  return h.length === e.length && timingSafeEqual(h, e);
}

/**
 * Minimal in-memory attempt limiter (per-process). Used for auth endpoints:
 * `fail()` records an attempt, `succeed()` clears the key, `isBlocked()`
 * reports whether the key has reached `max` attempts inside the window.
 * Deliberately not distributed — a single-process deployment control that
 * complements the global @fastify/rate-limit ceiling.
 */
export class AttemptLimiter {
  private map = new Map<string, { count: number; resetAt: number }>();
  constructor(private windowMs: number, private max: number) {}
  private entry(key: string): { count: number; resetAt: number } {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + this.windowMs }; this.map.set(key, e); }
    return e;
  }
  isBlocked(key: string): boolean {
    const e = this.map.get(key);
    return Boolean(e) && e!.resetAt > Date.now() && e!.count >= this.max;
  }
  fail(key: string): void { this.entry(key).count++; }
  succeed(key: string): void { this.map.delete(key); }
}

export function signToken(payload: Record<string, unknown>, ttlMs: number): string {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
  return data + "." + createHmac("sha256", SECRET).update(data).digest("base64url");
}
export function verifyToken<T extends { exp: number }>(token: string): T | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(data).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(data, "base64url").toString()) as T; return Date.now() > p.exp ? null : p; }
  catch { return null; }
}

/** AES-256-GCM encryption for Meta access tokens at rest. Tokens are never returned to clients. */
const encKey = createHash("sha256").update("metaops-token-key:" + SECRET).digest();
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function decryptSecret(stored: string): string | null {
  try {
    const [iv, tag, ct] = stored.split(".").map((s) => Buffer.from(s, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch { return null; }
}

/** Canonical hash binding an approval to the exact payload it was granted for. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}
export function payloadHash(payload: unknown): string {
  return sha256hex(canonicalJson(payload));
}
