/**
 * Gate A live smoke tests (A–D from META_APP_SETUP.md §6).
 * Runs ONLY what the available credentials allow and reports each check as
 * PASS / FAIL / BLOCKED with the real API outcome. It never fabricates a pass:
 * a check with missing credentials is BLOCKED, not skipped-as-passed.
 *
 * Inputs (env or repo-root .env):
 *   MODEL_API_KEY                 — Meta Model API key (Standard tier)
 *   METAOPS_SMOKE_PAGE_ID         — test Page ID
 *   METAOPS_SMOKE_PAGE_TOKEN      — Page access token for that Page
 * Usage: ./node_modules/.bin/tsx scripts/live-smoke.mts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// tiny .env reader (same allowlist spirit as the server loader)
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && process.env[line.slice(0, eq).trim()] === undefined) {
      process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
}

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || "v21.0"}`;
const MODEL_BASE = process.env.META_API_BASE || "https://api.meta.ai/v1";
type Outcome = { check: string; result: "PASS" | "FAIL" | "BLOCKED"; evidence: string };
const out: Outcome[] = [];

// ---- A: live AI auth + model availability ----
const key = process.env.MODEL_API_KEY;
if (!key) {
  out.push({ check: "A. Meta Model API authenticated call", result: "BLOCKED", evidence: "MODEL_API_KEY not configured. Run scripts/set-model-key.sh." });
} else {
  try {
    const res = await fetch(`${MODEL_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await res.text();
    if (!res.ok) out.push({ check: "A. Meta Model API authenticated call", result: "FAIL", evidence: `GET /models -> HTTP ${res.status}: ${body.slice(0, 160)}` });
    else {
      const ids = ((JSON.parse(body) as { data?: Array<{ id?: string }> }).data || []).map((m) => m.id);
      const has = ids.includes(process.env.METAOPS_MODEL || "muse-wonder-1.0");
      out.push({ check: "A. Meta Model API authenticated call", result: has ? "PASS" : "FAIL", evidence: has ? `Authenticated; ${(process.env.METAOPS_MODEL || "muse-wonder-1.0")} listed among ${ids.length} models.` : `Authenticated but primary model not listed. Models: ${ids.slice(0, 10).join(", ")}` });
    }
  } catch (e) { out.push({ check: "A. Meta Model API authenticated call", result: "FAIL", evidence: `Network error: ${String(e).slice(0, 160)}` }); }
}

// ---- B: live platform read (test Page profile + conversations) ----
const pageId = process.env.METAOPS_SMOKE_PAGE_ID;
const pageToken = process.env.METAOPS_SMOKE_PAGE_TOKEN;
if (!pageId || !pageToken) {
  out.push({ check: "B. Live Graph read (test Page)", result: "BLOCKED", evidence: "METAOPS_SMOKE_PAGE_ID / METAOPS_SMOKE_PAGE_TOKEN not set. Create the Meta app + test Page per META_APP_SETUP.md." });
} else {
  try {
    const res = await fetch(`${GRAPH}/${pageId}?fields=name,fan_count`, { headers: { Authorization: `Bearer ${pageToken}` } });
    const body = await res.text();
    out.push({ check: "B. Live Graph read (test Page)", result: res.ok ? "PASS" : "FAIL", evidence: `GET /${pageId} -> HTTP ${res.status}: ${body.slice(0, 200)}` });
  } catch (e) { out.push({ check: "B. Live Graph read (test Page)", result: "FAIL", evidence: `Network error: ${String(e).slice(0, 160)}` }); }
}

// ---- C/D require a running server + live connection; report readiness only ----
out.push({
  check: "C. Live approved send with read-back",
  result: "BLOCKED",
  evidence: "Requires the server running with the live Page connection added (Connections UI) and a drafted reply to approve. Procedure: META_APP_SETUP.md §6C."
});
out.push({
  check: "D. Failure honesty (revoked token surfaces graph_error_*)",
  result: "BLOCKED",
  evidence: "Requires C first, then revoking the token in the Meta console and re-running a sync. Procedure: META_APP_SETUP.md §6D."
});

console.log("\n=== MetaOps AI — Gate A live smoke report ===");
for (const o of out) console.log(`[${o.result}] ${o.check}\n       ${o.evidence}`);
const passes = out.filter((o) => o.result === "PASS").length;
console.log(`\n${passes}/${out.length} checks passed. Gate A requires A + B + C + D all PASS — do not report Gate A passed from this script alone.`);
process.exit(0);
