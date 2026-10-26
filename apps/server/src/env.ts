/**
 * Minimal .env loader (no dependency). Reads KEY=VALUE lines from the first
 * .env found at the process cwd or the repo root, for an explicit allowlist
 * of variable names only. Existing process.env values always win. Values are
 * never logged. Import this module before any module that reads env at load
 * time (ESM evaluates imports in order).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ALLOWLIST = new Set([
  "PORT", "HOST", "METAOPS_SECRET", "MODEL_API_KEY", "META_API_BASE",
  "METAOPS_MODEL", "METAOPS_MODEL_ALT", "GRAPH_API_VERSION", "METAOPS_DB",
  "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "PUBLIC_BASE_URL",
  "META_APP_ID", "META_OAUTH_REDIRECT_URI", "META_GRAPH_BASE_URL", "APP_WEB_BASE_URL"
]);

function loadEnvFile(file: string): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!ALLOWLIST.has(key)) continue;
    if (process.env[key] !== undefined) continue; // real environment wins
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
  return true;
}

const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(import.meta.dirname, "../../../.env")
];
// Tests must be hermetic: under vitest, never pull the developer's real .env
// (a live MODEL_API_KEY in tests caused slow live calls, non-deterministic
// drafts, and surprise API spend). VITEST is set by the test runner.
if (!process.env.VITEST) {
  for (const c of candidates) {
    if (loadEnvFile(c)) break;
  }
}
