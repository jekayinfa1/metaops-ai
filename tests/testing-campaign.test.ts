import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = mkdtempSync(path.join(tmpdir(), "metaops-p7-"));
process.env.METAOPS_DATA_DIR = SCRATCH;
process.env.METAOPS_SECRET = "<MASKED_SECRET_002>";
process.env.META_WEBHOOK_VERIFY_TOKEN = "p7-verify-token";
process.env.META_APP_SECRET = "p7-app-secret";
delete process.env.MODEL_API_KEY; // heuristic path; the 429 test sets a fake key locally

/**
 * Priority Seven testing campaign (2026-10-26). Targeted coverage for the
 * gaps the earlier suites did not pin:
 *  - AI client HTTP 429 behaviour (documents current contract; see finding)
 *  - webhook redelivery under concurrency + signature/body tampering
 *    (sequential dedupe and forged-signature rejection were already pinned
 *    by tests/live-readiness.test.ts)
 *  - approval replay (sequential + concurrent) and tampered-payload guard
 *  - concurrent executeExternalAction with one idempotency key (the ledger
 *    was previously exercised sequentially only, tests/graph-adapter.test.ts)
 *  - expired session / expired token / revoked session through requireAuth
 *    (logout itself was already pinned by tests/security-hardening.test.ts)
 *  - test-isolation guard (the oauth suite wrote into the dev DB; fixed in
 *    tests/oauth.test.ts + a getDb() guard in db/store.ts)
 *  - mobile navigation: the repo has NO DOM/component test setup (vitest
 *    runs the node environment over tests/** only; apps/web has no test
 *    harness), so this is a structural source-level smoke assertion, as the
 *    campaign brief allows — it pins the responsive nav contract in App.tsx.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = String(Date.now());
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any, security: any, engine: any, sandboxMod: any, ai: any;

let ownerToken = "";
let ownerId = "";
let businessId = "";
const OWNER_EMAIL = `p7-owner-${RUN}@example.com`;
const PAGE_ID = `P7PAGE-${RUN}`;
const CONN_ID = `p7-conn-${RUN}`;

const sign = (raw: string) => "sha256=" + createHmac("sha256", "p7-app-secret").update(raw, "utf8").digest("hex");
function pagePayload(mid: string, text: string) {
  return JSON.stringify({
    object: "page",
    entry: [{
      id: PAGE_ID, time: Date.now(),
      messaging: [{ sender: { id: `PSID-${RUN}` }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid, text } }]
    }]
  });
}

beforeAll(async () => {
  store = await import("../apps/server/src/db/store");
  security = await import("../apps/server/src/services/security");
  engine = await import("../apps/server/src/services/engine");
  sandboxMod = await import("../apps/server/src/adapters/sandbox");
  ai = await import("../apps/server/src/services/ai");
  const server = await import("../apps/server/src/index");
  app = await server.buildApp();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: OWNER_EMAIL, password: "correct horse battery" } });
  expect(reg.statusCode).toBe(200);
  ownerToken = reg.json().token;
  ownerId = (store.getDb().prepare("SELECT id FROM users WHERE email=?").get(OWNER_EMAIL) as { id: string }).id;
  const biz = await app.inject({ method: "POST", url: "/api/businesses", headers: auth(ownerToken), payload: { name: `P7 Biz ${RUN}` } });
  businessId = biz.json().business.id;
  // A live connection the webhook tests ingest against.
  store.getDb().prepare("INSERT INTO connections (id, business_id, platform, mode, display_name, external_account_id, status, permissions_json, created_at) VALUES (?,?,?,?,?,?, 'connected', '[]', ?)")
    .run(CONN_ID, businessId, "facebook", "live", "P7 Page", PAGE_ID, new Date().toISOString());
});

// ---------------------------------------------------------------- isolation
describe("test isolation guard", () => {
  it("this suite's database is a scratch file under the OS temp dir, never the dev DB", () => {
    const rows = store.getDb().prepare("PRAGMA database_list").all() as Array<{ file: string }>;
    const file = rows.find((r) => r.file)?.file ?? "";
    expect(file.startsWith(tmpdir())).toBe(true);
    expect(file).not.toBe(path.join(REPO, "data", "metaops.db"));
    expect(process.env.METAOPS_DATA_DIR).toBe(SCRATCH);
  });

  it("getDb() refuses to open any database under vitest without an explicit scratch location", () => {
    const probe = path.join(SCRATCH, "probe.ts");
    writeFileSync(probe, `
import { getDb } from ${JSON.stringify(path.join(REPO, "apps/server/src/db/store.ts"))};
try {
  const db = getDb();
  const rows = db.prepare("PRAGMA database_list").all();
  console.log("OPENED " + JSON.stringify(rows));
} catch (e) { console.log("REFUSED " + (e as Error).message); }
`);
    const runProbe = (extraEnv: Record<string, string>) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VITEST: "true", ...extraEnv };
      const r = spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), probe], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
      return (r.stdout ?? "") + (r.stderr ?? "");
    };
    // Case 1: no location configured at all -> refuse (this is the exact
    // configuration the pre-fix oauth suite ran with, from the repo root).
    const noLoc = runProbe({});
    expect(noLoc).toContain("REFUSED");
    expect(noLoc).toContain("test isolation");
    expect(noLoc).not.toContain("OPENED");
    // Case 2: location configured but pointing at the development data dir.
    const devDir = runProbe({ METAOPS_DATA_DIR: path.join(REPO, "data") });
    expect(devDir).toContain("REFUSED");
    expect(devDir).toContain("development data directory");
    expect(devDir).not.toContain("OPENED");
  });
});

// ------------------------------------------------------------- AI client 429
describe("Meta AI client: HTTP 429 handling (current contract)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  beforeEach(() => {
    fetchCalls = 0;
    process.env.MODEL_API_KEY = "p7-fake-key";
    globalThis.fetch = (async () => {
      fetchCalls++;
      return {
        ok: false, status: 429,
        text: async () => JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Too many requests", type: "rate_limit_error" } })
      };
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MODEL_API_KEY;
  });

  it("surfaces meta_api_429 after exactly ONE attempt (no retry/backoff in the client)", async () => {
    // FINDING (documented, not redesigned): metaJson() in services/ai.ts has
    // no 429 handling — no retry, no backoff, no Retry-After parsing. The
    // error propagates to the caller (engine / route) as meta_api_429.
    await expect(ai.classifyMessage("p7-429", "hello", [])).rejects.toThrow(/meta_api_429/);
    expect(fetchCalls).toBe(1);
    // A failed call is not recorded as usage.
    const logged = store.getDb().prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE task_id='p7-429'").get() as { n: number };
    expect(logged.n).toBe(0);
  });
});

// ------------------------------------------------------------------ webhooks
describe("webhook redelivery under concurrency + tampered body", () => {
  const post = (raw: string, signature: string) =>
    app.inject({ method: "POST", url: "/webhooks/meta", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, payload: raw });

  it("two simultaneous deliveries of the same event insert exactly one message", async () => {
    const mid = `mid-p7-${RUN}`;
    const raw = pagePayload(mid, "Do you ship to Austin?");
    const [r1, r2] = await Promise.all([post(raw, sign(raw)), post(raw, sign(raw))]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const inserted = (r1.json().inserted as number) + (r2.json().inserted as number);
    const duplicates = (r1.json().duplicates as number) + (r2.json().duplicates as number);
    expect(inserted).toBe(1);
    expect(duplicates).toBe(1);
    const msgs = store.getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE external_id=?").get(mid) as { n: number };
    expect(msgs.n).toBe(1);
    const convs = store.getDb().prepare("SELECT COUNT(*) AS n FROM conversations WHERE connection_id=?").get(CONN_ID) as { n: number };
    expect(convs.n).toBe(1);
  });

  it("a body altered after signing is rejected 401 and ingests nothing", async () => {
    const mid = `mid-p7-tampered-${RUN}`;
    const signedRaw = pagePayload(mid, "original text");
    const tamperedRaw = pagePayload(mid, "FORGED text");
    const res = await post(tamperedRaw, sign(signedRaw)); // signature is for the OTHER body
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_signature");
    const msgs = store.getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE external_id=?").get(mid) as { n: number };
    expect(msgs.n).toBe(0);
  });
});

// ----------------------------------------------------------------- approvals
describe("approval replay and tamper guards", () => {
  const insertApproval = (payload: unknown, hash: string) => {
    const id = `p7-appr-${Math.random().toString(36).slice(2)}-${RUN}`;
    store.getDb().prepare("INSERT INTO approvals (id, business_id, task_id, kind, platform, summary, payload_json, payload_hash, status, created_at) VALUES (?,?, NULL, 'send_message', 'messenger', 'P7 approval', ?, ?, 'pending', ?)")
      .run(id, businessId, JSON.stringify(payload), hash, new Date().toISOString());
    return id;
  };
  const approve = (id: string) => app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: auth(ownerToken) });

  it("concurrent double-approve decides exactly once; a later replay also gets 409", async () => {
    const payload = { conversationId: `conv-${RUN}`, body: "hello from p7" };
    const id = insertApproval(payload, security.payloadHash(payload));
    const [a, b] = await Promise.all([approve(id), approve(id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("approval_already_decided");
    const row = store.getDb().prepare("SELECT status, decided_by FROM approvals WHERE id=?").get(id) as { status: string; decided_by: string };
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe(ownerId);
    const audits = store.getDb().prepare("SELECT COUNT(*) AS n FROM audit WHERE event='approval_approved' AND detail=?").get(id) as { n: number };
    expect(audits.n).toBe(1);
    // Sequential replay after the race: still a conflict, still one decision.
    const replay = await approve(id);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("approval_already_decided");
    const audits2 = store.getDb().prepare("SELECT COUNT(*) AS n FROM audit WHERE event='approval_approved' AND detail=?").get(id) as { n: number };
    expect(audits2.n).toBe(1);
  });

  it("an approval whose stored payload no longer matches its hash can be neither approved nor rejected", async () => {
    const id = insertApproval({ body: "original" }, security.payloadHash({ body: "tampered elsewhere" }));
    const res = await approve(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("approval_payload_mismatch");
    const rej = await app.inject({ method: "POST", url: `/api/approvals/${id}/reject`, headers: auth(ownerToken) });
    expect(rej.statusCode).toBe(409);
    expect(rej.json().error).toBe("approval_payload_mismatch");
    const row = store.getDb().prepare("SELECT status FROM approvals WHERE id=?").get(id) as { status: string };
    expect(row.status).toBe("pending");
  });
});

// ------------------------------------------------- concurrent idempotent exec
describe("concurrent executeExternalAction with the same idempotency key", () => {
  it("performs exactly one sandbox send; the concurrent caller is told unverified, never double-sends", async () => {
    const conn = {
      id: `p7-sbx-${RUN}`, businessId, platform: "messenger", mode: "sandbox",
      displayName: "P7 Sandbox", externalAccountId: "sbx_page", tokenEncrypted: null,
      tokenExpiresAt: null, status: "connected", permissionsJson: "[]"
    };
    const adapter = new sandboxMod.SandboxAdapter(conn);
    const target = { threadId: `thread-${RUN}`, recipientId: `cust-${RUN}` };
    const key = `p7-concurrent-${RUN}`;
    let fnCalls = 0;
    const fn = async () => { fnCalls++; return adapter.sendMessage(target, "hello", key); };
    const outcomes = await Promise.all([
      engine.executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn),
      engine.executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn)
    ]);
    expect(fnCalls).toBe(1);
    expect(outcomes.filter((o) => o.kind === "accepted")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "unverified")).toHaveLength(1);
    const objects = store.getDb().prepare("SELECT COUNT(*) AS n FROM sandbox_objects WHERE id=?").get("sbx_msg_" + key) as { n: number };
    expect(objects.n).toBe(1);
    const ledger = store.getDb().prepare("SELECT status FROM action_executions WHERE idempotency_key=?").get(key) as { status: string };
    expect(ledger.status).toBe("accepted");
    // A later sequential call replays the recorded outcome, still no resend.
    const replay = await engine.executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn);
    expect(replay).toMatchObject({ kind: "accepted", replayed: true });
    expect(fnCalls).toBe(1);
  });
});

// ------------------------------------------------------------------ sessions
describe("expired and revoked sessions are rejected by requireAuth", () => {
  const businesses = (t: string) => app.inject({ method: "GET", url: "/api/businesses", headers: auth(t) });
  const jtiOf = (t: string) => (JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()) as { jti: string }).jti;

  it("rejects a session whose server-side expiry has passed, even with a well-signed token", async () => {
    const email = `p7-exp-${RUN}@example.com`;
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "correct horse battery" } });
    const token = reg.json().token as string;
    expect((await businesses(token)).statusCode).toBe(200);
    store.getDb().prepare("UPDATE sessions SET expires_at=? WHERE jti=?").run(Date.now() - 1000, jtiOf(token));
    const res = await businesses(token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_revoked");
  });

  it("rejects a token whose own exp has passed (401 unauthorized)", async () => {
    const email = `p7-exp2-${RUN}@example.com`;
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "correct horse battery" } });
    const live = reg.json().token as string;
    const uid = (store.getDb().prepare("SELECT id FROM users WHERE email=?").get(email) as { id: string }).id;
    const expired = security.signToken({ sub: uid, email, jti: jtiOf(live) }, -1000);
    const res = await businesses(expired);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects a logged-out (revoked) session while a fresh session for the same user still works", async () => {
    const email = `p7-rev-${RUN}@example.com`;
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "correct horse battery" } });
    const token = reg.json().token as string;
    expect((await businesses(token)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth(token) })).statusCode).toBe(200);
    const res = await businesses(token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_revoked");
    const relogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "correct horse battery" } });
    expect(relogin.statusCode).toBe(200);
    expect((await businesses(relogin.json().token as string)).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------ mobile nav
describe("mobile navigation (structural smoke — no DOM test setup in repo)", () => {
  const src = readFileSync(path.join(REPO, "apps/web/src/App.tsx"), "utf8");

  it("defines all nine primary destinations in NAV", () => {
    for (const label of ["Dashboard", "AI Operator", "Inbox", "Leads", "Content", "Approvals", "Proof", "Connections", "Business"]) {
      expect(src).toContain(`label: "${label}"`);
    }
  });

  it("renders a bottom mobile nav (visible below lg) covering every NAV destination", () => {
    const start = src.indexOf('aria-label="Primary mobile"');
    expect(start).toBeGreaterThan(-1);
    const navTag = src.slice(src.lastIndexOf("<nav", start), start);
    expect(navTag).toContain("fixed");
    expect(navTag).toContain("bottom-0");
    expect(navTag).toContain("lg:hidden");
    const mobile = src.slice(start);
    expect(mobile).toContain("NAV.slice(0, 4)");
    expect(mobile).toContain('setScreen("approvals")');
    expect(mobile).toContain("NAV.slice(5)");
  });

  it("keeps the desktop sidebar hidden below lg (the mobile nav is the small-viewport path)", () => {
    const start = src.indexOf('aria-label="Primary"');
    expect(start).toBeGreaterThan(-1);
    const navTag = src.slice(src.lastIndexOf("<nav", start), start);
    expect(navTag).toContain("hidden");
    expect(navTag).toContain("lg:flex");
  });
});