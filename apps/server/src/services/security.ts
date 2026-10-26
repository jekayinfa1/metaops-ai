import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";

const SECRET = process.env.METAOPS_SECRET || "metaops-local-dev-secret-change-me";
export const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const randomToken = (n = 32) => randomBytes(n).toString("base64url");

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pw, salt, 64).toString("hex");
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const h = scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  const e = Buffer.from(hashHex, "hex");
  return h.length === e.length && timingSafeEqual(h, e);
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
