import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getDb, audit } from "../db/store.js";
import { hashPassword, verifyPassword, signToken, verifyToken, encryptSecret, payloadHash, sha256hex, randomToken, AttemptLimiter } from "../services/security.js";
import { adapterFor } from "../adapters/factory.js";
import type { ConnectionRow } from "../adapters/types.js";
import { createTask, pauseTask, resumeTask, cancelTask, subscribeTask, emit } from "../services/engine.js";
import { buildReceipt } from "../services/receipt.js";
import { aiConfigured, verifyModelApi, PRIMARY_MODEL, ALT_MODEL, DEMO_HEURISTIC_MODEL } from "../services/ai.js";
import { HARBOR_BUSINESS, HARBOR_PRODUCTS } from "../services/seed-data.js";

const TOKEN_TTL = 8 * 3600 * 1000;
const now = () => new Date().toISOString();
interface Auth { sub: string; email: string; exp: number; jti?: string }

// ---- server-side session registry -------------------------------------------
// Session tokens are HMAC-signed AND registered server-side, so they can be
// revoked before expiry: sign-out kills the current session, and a password
// change or "sign out everywhere" kills them all. (Previously tokens were
// purely stateless — a leaked token was valid until expiry, with no remedy.)
let sessionsReady = false;
function ensureSessions(): void {
  if (sessionsReady) return;
  getDb().exec(`CREATE TABLE IF NOT EXISTS sessions (
    jti TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`);
  sessionsReady = true;
}
function issueSession(userId: string, email: string): string {
  ensureSessions();
  const jti = randomUUID();
  getDb().prepare("INSERT INTO sessions (jti, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .run(jti, userId, now(), Date.now() + TOKEN_TTL);
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()); // opportunistic cleanup
  return signToken({ sub: userId, email, jti }, TOKEN_TTL);
}
function sessionValid(jti: string): boolean {
  ensureSessions();
  const row = getDb().prepare("SELECT revoked, expires_at as expiresAt FROM sessions WHERE jti=?")
    .get(jti) as unknown as { revoked: number; expiresAt: number } | undefined;
  return Boolean(row) && row!.revoked === 0 && row!.expiresAt > Date.now();
}
function revokeSession(jti: string): void {
  ensureSessions();
  getDb().prepare("UPDATE sessions SET revoked=1 WHERE jti=?").run(jti);
}
function revokeAllSessions(userId: string): number {
  ensureSessions();
  const res = getDb().prepare("UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0").run(userId) as unknown as { changes: number };
  return res.changes;
}

// Auth-endpoint attempt limiters (in-memory, per process). Login is keyed by
// IP+email and counts FAILURES only (a success clears the key); registration
// is keyed by IP and counts every attempt. Both sit far below the global
// 600/min ceiling and far above legitimate test/demo traffic.
const loginLimiter = new AttemptLimiter(10 * 60 * 1000, 15);
const registerLimiter = new AttemptLimiter(10 * 60 * 1000, 30);
let dummyPasswordHash: string | null = null;

export function requireAuth(req: { headers: Record<string, string | string[] | undefined>; query?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, opts: { allowQueryToken?: boolean } = {}): Auth | null {
  const header = req.headers.authorization;
  let token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
  // Query-string tokens are accepted ONLY where a header cannot be set (the
  // SSE events stream, whose EventSource client has no header API). Tokens in
  // URLs leak into logs and history, so every other route requires the header.
  if (!token && opts.allowQueryToken && req.query && typeof req.query === "object") token = (req.query as { token?: string }).token ?? null;
  const payload = token ? verifyToken<Auth>(token) : null;
  if (!payload) { reply.code(401).send({ error: "unauthorized" }); return null; }
  // Registered sessions must still exist, be unrevoked, and be unexpired.
  // (Tokens without a jti are only ever minted by this server's own signing
  // key in tests/tools, never issued to clients, so they take the legacy path.)
  if (payload.jti && !sessionValid(payload.jti)) { reply.code(401).send({ error: "session_revoked" }); return null; }
  return payload;
}

export async function apiRoutes(app: FastifyInstance) {
  // The web client sends "Content-Type: application/json" on EVERY request,
  // including action POSTs with no body at all (task pause/resume/cancel,
  // approval approve/reject, logout/logout-all). Fastify's default JSON
  // parser rejects a zero-length body with 400 (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which silently broke those controls in the UI. Scoped to this plugin —
  // the same approach the webhook scope uses — an empty JSON body parses as
  // {}, while malformed JSON still fails with a 400 parser error and valid
  // bodies parse exactly as before. (The webhook parser deliberately swallows
  // parse errors to {}; this one must not, or bad client payloads would
  // silently become empty objects.)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const text = body as string;
    if (text.length === 0) return done(null, {});
    try { done(null, JSON.parse(text)); }
    catch {
      const err = new Error("invalid_json_body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const d = () => getDb();
  const ownBusiness = (userId: string, id: string) =>
    d().prepare("SELECT * FROM businesses WHERE id=? AND user_id=?").get(id, userId) as Record<string, unknown> | undefined;

  app.get("/api/ai/status", async () => ({
    configured: aiConfigured(),
    primaryModel: aiConfigured() ? PRIMARY_MODEL : DEMO_HEURISTIC_MODEL,
    fallbackModel: aiConfigured() ? ALT_MODEL : DEMO_HEURISTIC_MODEL,
    note: aiConfigured() ? "Meta Model API configured." : "MODEL_API_KEY not configured: deterministic demo planner/classifier in use. It is NOT Meta AI and is labelled as such in the UI and receipts."
  }));

  // Live self-check: performs a REAL authenticated GET /models against the
  // Meta Model API and reports the outcome verbatim (see verifyModelApi).
  app.post("/api/ai/verify", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const result = await verifyModelApi();
    audit("user:" + auth.sub, "ai_verify", JSON.stringify({ status: result.status, ok: result.ok }));
    return result;
  });

  // ---- auth ----
  app.post("/api/auth/register", async (req, reply) => {
    const regKey = `register|${req.ip}`;
    if (registerLimiter.isBlocked(regKey)) return reply.code(429).send({ error: "too_many_attempts" });
    registerLimiter.fail(regKey);
    const body = z.object({ email: z.string().email(), password: z.string().min(8).max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_email_or_password" });
    if (d().prepare("SELECT id FROM users WHERE email=?").get(body.data.email)) return reply.code(409).send({ error: "email_already_registered" });
    const id = randomUUID();
    d().prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)").run(id, body.data.email, hashPassword(body.data.password), now());
    audit("user:" + id, "registered");
    return { token: issueSession(id, body.data.email), userId: id };
  });
  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const key = `${req.ip}|${body.data.email.toLowerCase()}`;
    if (loginLimiter.isBlocked(key)) return reply.code(429).send({ error: "too_many_attempts" });
    const row = d().prepare("SELECT id, password_hash as passwordHash FROM users WHERE email=?").get(body.data.email) as unknown as { id: string; passwordHash: string } | undefined;
    if (!row) {
      // Run scrypt against a dummy hash anyway, so a missing account costs the
      // same time as a wrong password and does not leak existence via timing.
      dummyPasswordHash ??= hashPassword(randomToken(16));
      verifyPassword(body.data.password, dummyPasswordHash);
      loginLimiter.fail(key);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (!verifyPassword(body.data.password, row.passwordHash)) {
      loginLimiter.fail(key);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    loginLimiter.succeed(key);
    return { token: issueSession(row.id, body.data.email), userId: row.id };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    if (auth.jti) revokeSession(auth.jti);
    audit("user:" + auth.sub, "logout");
    return { ok: true };
  });
  app.post("/api/auth/logout-all", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const revoked = revokeAllSessions(auth.sub);
    audit("user:" + auth.sub, "logout_all", `${revoked} session(s)`);
    return { ok: true, revoked };
  });
  app.post("/api/auth/change-password", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_password" });
    const key = `${req.ip}|${auth.email.toLowerCase()}`;
    if (loginLimiter.isBlocked(key)) return reply.code(429).send({ error: "too_many_attempts" });
    const row = d().prepare("SELECT password_hash as passwordHash FROM users WHERE id=?").get(auth.sub) as unknown as { passwordHash: string } | undefined;
    if (!row || !verifyPassword(body.data.currentPassword, row.passwordHash)) {
      loginLimiter.fail(key);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    d().prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(body.data.newPassword), auth.sub);
    // A password change revokes EVERY existing session for the account; the
    // caller receives one fresh session in the response.
    revokeAllSessions(auth.sub);
    audit("user:" + auth.sub, "password_changed");
    return { token: issueSession(auth.sub, auth.email), userId: auth.sub };
  });

  // ---- businesses & knowledge base ----
  app.post("/api/businesses", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const body = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).default("") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_business" });
    const id = randomUUID();
    d().prepare("INSERT INTO businesses (id, user_id, name, description, created_at) VALUES (?,?,?,?,?)").run(id, auth.sub, body.data.name, body.data.description, now());
    return { business: d().prepare("SELECT * FROM businesses WHERE id=?").get(id) };
  });
  app.get("/api/businesses", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    return { businesses: d().prepare("SELECT * FROM businesses WHERE user_id=?").all(auth.sub) };
  });
  app.get("/api/businesses/:id", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const b = ownBusiness(auth.sub, (req.params as { id: string }).id);
    if (!b) return reply.code(404).send({ error: "business_not_found" });
    return { business: b };
  });
  app.put("/api/businesses/:id", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const body = z.object({
      name: z.string().min(1).max(120).optional(), description: z.string().max(2000).optional(),
      hours: z.string().max(300).optional(), location: z.string().max(300).optional(),
      returnPolicy: z.string().max(1000).optional(), tone: z.string().max(200).optional(),
      escalationContact: z.string().max(200).optional(),
      faqs: z.array(z.object({ q: z.string().max(300), a: z.string().max(1000) })).max(50).optional()
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_update" });
    const cols: Record<string, string> = { name: "name", description: "description", hours: "hours", location: "location", returnPolicy: "return_policy", tone: "tone", escalationContact: "escalation_contact" };
    for (const [k, col] of Object.entries(cols)) {
      const v = (body.data as Record<string, unknown>)[k];
      if (v !== undefined) d().prepare(`UPDATE businesses SET ${col}=? WHERE id=?`).run(v as string, id);
    }
    if (body.data.faqs) d().prepare("UPDATE businesses SET faqs_json=? WHERE id=?").run(JSON.stringify(body.data.faqs), id);
    return { business: d().prepare("SELECT * FROM businesses WHERE id=?").get(id) };
  });

  // ---- products ----
  app.get("/api/businesses/:id/products", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    return { products: d().prepare("SELECT id, name, description, price_cents as priceCents, currency, in_stock as inStock, sku FROM products WHERE business_id=?").all(id) };
  });
  app.post("/api/businesses/:id/products", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const body = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).default(""), priceCents: z.number().int().min(0).nullable().default(null), inStock: z.boolean().default(true), sku: z.string().max(60).default("") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_product" });
    const pid = randomUUID();
    d().prepare("INSERT INTO products (id, business_id, name, description, price_cents, in_stock, sku) VALUES (?,?,?,?,?,?,?)")
      .run(pid, id, body.data.name, body.data.description, body.data.priceCents, body.data.inStock ? 1 : 0, body.data.sku);
    return { product: d().prepare("SELECT * FROM products WHERE id=?").get(pid) };
  });
  app.post("/api/businesses/:id/products/import", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const body = z.object({ csv: z.string().max(100_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_csv" });
    // CSV format: name,price,in_stock,sku,description (header row optional)
    const lines = body.data.csv.split(/\r?\n/).filter((l) => l.trim().length);
    let imported = 0; const errors: string[] = [];
    lines.forEach((line, i) => {
      const cells = line.split(",").map((c) => c.trim());
      if (i === 0 && cells[0].toLowerCase() === "name") return;
      if (cells.length < 2 || !cells[0]) { errors.push(`line ${i + 1}: needs at least name,price`); return; }
      const price = Number(cells[1]);
      if (Number.isNaN(price)) { errors.push(`line ${i + 1}: price not a number`); return; }
      d().prepare("INSERT INTO products (id, business_id, name, description, price_cents, in_stock, sku) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), id, cells[0], cells[4] ?? "", Math.round(price * 100), (cells[2] ?? "true").toLowerCase() === "false" || cells[2] === "0" ? 0 : 1, cells[3] ?? "");
      imported++;
    });
    return { imported, errors };
  });

  // ---- connections ----
  const connView = async (row: Record<string, unknown>) => {
    const conn: ConnectionRow = {
      id: row.id as string, businessId: row.business_id as string, platform: row.platform as ConnectionRow["platform"],
      mode: row.mode as ConnectionRow["mode"], displayName: row.display_name as string,
      externalAccountId: row.external_account_id as string, tokenEncrypted: (row.token_encrypted as string | null) ?? null,
      tokenExpiresAt: (row.token_expires_at as string | null) ?? null, status: row.status as string,
      permissionsJson: (row.permissions_json as string) ?? "[]"
    };
    const adapter = adapterFor(conn);
    const caps = await adapter.capabilities().catch((e: Error) => [{ key: "error", label: e.message, available: false }]);
    return {
      id: row.id, businessId: row.business_id, platform: row.platform, mode: row.mode,
      displayName: row.display_name, externalAccountId: row.external_account_id,
      status: row.status, tokenExpiresAt: row.token_expires_at,
      permissions: JSON.parse((row.permissions_json as string) ?? "[]"),
      capabilities: caps,
      hasToken: Boolean(row.token_encrypted)
    };
  };
  app.get("/api/businesses/:id/connections", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const rows = d().prepare("SELECT * FROM connections WHERE business_id=?").all(id) as Array<Record<string, unknown>>;
    return { connections: await Promise.all(rows.map(connView)) };
  });
  app.post("/api/businesses/:id/connections", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const body = z.object({
      platform: z.enum(["facebook", "instagram", "messenger", "whatsapp"]),
      mode: z.enum(["sandbox", "live"]),
      displayName: z.string().min(1).max(120),
      externalAccountId: z.string().max(120).default(""),
      accessToken: z.string().max(2000).optional(),
      permissions: z.array(z.string()).max(40).default([])
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_connection" });
    if (body.data.mode === "live" && !body.data.accessToken) return reply.code(400).send({ error: "live_connection_requires_token" });
    const cid = randomUUID();
    d().prepare("INSERT INTO connections (id, business_id, platform, mode, display_name, external_account_id, token_encrypted, permissions_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(cid, id, body.data.platform, body.data.mode, body.data.displayName, body.data.externalAccountId,
        body.data.accessToken ? encryptSecret(body.data.accessToken) : null, JSON.stringify(body.data.permissions), now());
    audit("user:" + auth.sub, "connection_created", `${body.data.platform}/${body.data.mode}`);
    const row = d().prepare("SELECT * FROM connections WHERE id=?").get(cid) as Record<string, unknown>;
    return { connection: await connView(row) };
  });
  app.delete("/api/connections/:id", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    const row = d().prepare("SELECT c.* FROM connections c JOIN businesses b ON b.id=c.business_id WHERE c.id=? AND b.user_id=?").get(id, auth.sub);
    if (!row) return reply.code(404).send({ error: "connection_not_found" });
    d().prepare("UPDATE connections SET status='disconnected', token_encrypted=NULL WHERE id=?").run(id);
    return { disconnected: true };
  });

  // ---- inbox ----
  app.get("/api/businesses/:id/conversations", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const rows = d().prepare(`SELECT cv.id, cv.platform, cv.customer_name as customerName, cv.category, cv.lead_status as leadStatus,
      cv.product_interest as productInterest, cv.suggested_reply as suggestedReply, cv.workflow_state as workflowState, cv.last_message_at as lastMessageAt,
      cn.mode as connectionMode FROM conversations cv JOIN connections cn ON cn.id=cv.connection_id WHERE cv.business_id=? ORDER BY cv.last_message_at DESC`).all(id);
    return { conversations: rows };
  });
  app.get("/api/conversations/:id/messages", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    const conv = d().prepare("SELECT cv.* FROM conversations cv JOIN businesses b ON b.id=cv.business_id WHERE cv.id=? AND b.user_id=?").get(id, auth.sub);
    if (!conv) return reply.code(404).send({ error: "conversation_not_found" });
    return { messages: d().prepare("SELECT id, direction, body, at, status, external_id as externalId FROM messages WHERE conversation_id=? ORDER BY at").all(id) };
  });

  // ---- leads ----
  app.get("/api/businesses/:id/leads", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    return { leads: d().prepare("SELECT id, platform, customer_name as customerName, category, product_interest as productInterest, priority, explanation, status, follow_up_eligible as followUpEligible, last_contact_at as lastContactAt FROM leads WHERE business_id=? ORDER BY created_at DESC").all(id) };
  });

  // ---- content ----
  app.get("/api/businesses/:id/content", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    return { content: d().prepare("SELECT id, platform, kind, caption, status, external_id as externalId, scheduled_for as scheduledFor, created_at as createdAt FROM content_items WHERE business_id=? ORDER BY created_at DESC").all(id) };
  });
  app.post("/api/businesses/:id/content", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const body = z.object({ platform: z.enum(["facebook", "instagram", "messenger", "whatsapp"]), caption: z.string().min(1).max(4000), scheduledFor: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_content" });
    const cid = randomUUID();
    d().prepare("INSERT INTO content_items (id, business_id, platform, kind, caption, status, scheduled_for, created_at, idempotency_key) VALUES (?,?,?, 'post', ?, 'draft', ?, ?, ?)")
      .run(cid, id, body.data.platform, body.data.caption, body.data.scheduledFor ?? null, now(), `manual:${cid}`);
    return { content: d().prepare("SELECT * FROM content_items WHERE id=?").get(cid) };
  });

  // ---- approvals ----
  app.get("/api/approvals", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const businessId = (req.query as { businessId?: string }).businessId;
    if (!businessId || !ownBusiness(auth.sub, businessId)) return reply.code(404).send({ error: "business_not_found" });
    const rows = d().prepare("SELECT id, task_id as taskId, kind, platform, summary, payload_json as payloadJson, payload_hash as payloadHash, status, created_at as createdAt, decided_at as decidedAt FROM approvals WHERE business_id=? ORDER BY created_at DESC").all(businessId) as Array<Record<string, unknown>>;
    return { approvals: rows.map((r) => ({ ...r, payload: JSON.parse(r.payloadJson as string), payloadJson: undefined })) };
  });
  const decide = (decision: "approved" | "rejected") => async (req: { params: unknown; headers: Record<string, string | string[] | undefined> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    const row = d().prepare("SELECT a.* FROM approvals a JOIN businesses b ON b.id=a.business_id WHERE a.id=? AND b.user_id=?").get(id, auth.sub) as unknown as { id: string; status: string; payloadJson: string; payloadHash: string } | undefined;
    if (!row) return reply.code(404).send({ error: "approval_not_found" });
    if (row.status !== "pending") return reply.code(409).send({ error: "approval_already_decided" });
    // Stale-approval guard: the stored payload must still hash to the approved payload hash.
    const payload = JSON.parse((row as unknown as { payload_json: string }).payload_json);
    if (payloadHash(payload) !== (row as unknown as { payload_hash: string }).payload_hash) return reply.code(409).send({ error: "approval_payload_mismatch" });
    d().prepare("UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=?").run(decision, now(), auth.sub, id);
    audit("user:" + auth.sub, "approval_" + decision, id);
    return { approval: d().prepare("SELECT * FROM approvals WHERE id=?").get(id) };
  };
  app.post("/api/approvals/:id/approve", decide("approved"));
  app.post("/api/approvals/:id/reject", decide("rejected"));
  app.post("/api/approvals/:id/edit", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    const row = d().prepare("SELECT a.* FROM approvals a JOIN businesses b ON b.id=a.business_id WHERE a.id=? AND b.user_id=?").get(id, auth.sub) as unknown as { business_id: string; task_id: string | null; kind: string; platform: string; summary: string; status: string } | undefined;
    if (!row) return reply.code(404).send({ error: "approval_not_found" });
    if (row.status !== "pending") return reply.code(409).send({ error: "approval_already_decided" });
    const body = z.object({ payload: z.record(z.unknown()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload" });
    // Editing NEVER mutates the approved action in place: the old approval is
    // invalidated and a fresh pending approval is created for the new payload.
    d().prepare("UPDATE approvals SET status='invalidated', decided_at=? WHERE id=?").run(now(), id);
    const nid = randomUUID();
    d().prepare("INSERT INTO approvals (id, business_id, task_id, kind, platform, summary, payload_json, payload_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?)")
      .run(nid, row.business_id, row.task_id, row.kind, row.platform, row.summary, JSON.stringify(body.data.payload), payloadHash(body.data.payload), now());
    // If the edit changed a message body, sync the conversation's suggested reply so the engine sends the edited text.
    // Both updates are scoped to the approval's own business: a crafted payload
    // must never be able to write into another business's rows by id.
    const p = body.data.payload as { conversationId?: string; body?: string; contentId?: string; caption?: string };
    if (p.conversationId && typeof p.body === "string") d().prepare("UPDATE conversations SET suggested_reply=? WHERE id=? AND business_id=?").run(p.body, p.conversationId, row.business_id);
    if (p.contentId && typeof p.caption === "string") d().prepare("UPDATE content_items SET caption=? WHERE id=? AND business_id=?").run(p.caption, p.contentId, row.business_id);
    return { approval: d().prepare("SELECT * FROM approvals WHERE id=?").get(nid), invalidated: id };
  });

  // ---- tasks ----
  app.post("/api/businesses/:id/tasks", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    const body = z.object({ objective: z.string().min(3).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_objective" });
    const taskId = await createTask(id, auth.sub, body.data.objective);
    return { task: d().prepare("SELECT * FROM tasks WHERE id=?").get(taskId) };
  });
  app.get("/api/businesses/:id/tasks", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    if (!ownBusiness(auth.sub, id)) return reply.code(404).send({ error: "business_not_found" });
    return { tasks: d().prepare("SELECT * FROM tasks WHERE business_id=? ORDER BY created_at DESC LIMIT 100").all(id) };
  });
  app.get("/api/tasks/:id", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    const task = d().prepare("SELECT t.* FROM tasks t JOIN businesses b ON b.id=t.business_id WHERE t.id=? AND b.user_id=?").get(id, auth.sub);
    if (!task) return reply.code(404).send({ error: "task_not_found" });
    return { task, steps: d().prepare("SELECT * FROM task_steps WHERE task_id=? ORDER BY seq").all(id) };
  });
  const ownTask = (userId: string, id: string) =>
    d().prepare("SELECT t.id FROM tasks t JOIN businesses b ON b.id=t.business_id WHERE t.id=? AND b.user_id=?").get(id, userId);
  app.post("/api/tasks/:id/pause", async (req, reply) => { const auth = requireAuth(req, reply); if (!auth) return; const { id } = req.params as { id: string }; if (!ownTask(auth.sub, id)) return reply.code(404).send({ error: "task_not_found" }); pauseTask(id); return { ok: true }; });
  app.post("/api/tasks/:id/resume", async (req, reply) => { const auth = requireAuth(req, reply); if (!auth) return; const { id } = req.params as { id: string }; if (!ownTask(auth.sub, id)) return reply.code(404).send({ error: "task_not_found" }); resumeTask(id); return { ok: true }; });
  app.post("/api/tasks/:id/cancel", async (req, reply) => { const auth = requireAuth(req, reply); if (!auth) return; const { id } = req.params as { id: string }; if (!ownTask(auth.sub, id)) return reply.code(404).send({ error: "task_not_found" }); cancelTask(id); return { ok: true }; });
  app.get("/api/tasks/:id/receipt", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { id } = req.params as { id: string };
    const task = d().prepare("SELECT t.id FROM tasks t JOIN businesses b ON b.id=t.business_id WHERE t.id=? AND b.user_id=?").get(id, auth.sub);
    if (!task) return reply.code(404).send({ error: "task_not_found" });
    return buildReceipt(id);
  });
  app.get("/api/tasks/:id/events", async (req, reply) => {
    // The one route that accepts a query-string token: EventSource cannot set
    // an Authorization header. Ownership is verified before the stream opens,
    // so a token only ever streams its owner's task events.
    const auth = requireAuth(req, reply, { allowQueryToken: true }); if (!auth) return;
    const { id } = req.params as { id: string };
    const owned = d().prepare("SELECT t.id FROM tasks t JOIN businesses b ON b.id=t.business_id WHERE t.id=? AND b.user_id=?").get(id, auth.sub);
    if (!owned) return reply.code(404).send({ error: "task_not_found" });
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (data: string) => reply.raw.write(`data: ${data}

`);
    const unsub = subscribeTask(id, send);
    emit(id);
    req.raw.on("close", unsub);
    // Keep the handler open; Fastify will end it when the socket closes.
    await new Promise(() => { /* never resolves */ });
  });

  // ---- demo seed: Harbor Goods (synthetic) ----
  app.post("/api/demo/seed", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const existing = d().prepare("SELECT id FROM businesses WHERE user_id=? AND name=?").get(auth.sub, HARBOR_BUSINESS.name) as { id: string } | undefined;
    if (existing) return { businessId: existing.id, alreadySeeded: true };
    const bid = randomUUID();
    d().prepare("INSERT INTO businesses (id, user_id, name, description, hours, location, return_policy, tone, escalation_contact, faqs_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(bid, auth.sub, HARBOR_BUSINESS.name, HARBOR_BUSINESS.description, HARBOR_BUSINESS.hours, HARBOR_BUSINESS.location, HARBOR_BUSINESS.returnPolicy, HARBOR_BUSINESS.tone, HARBOR_BUSINESS.escalationContact, JSON.stringify(HARBOR_BUSINESS.faqs), now());
    for (const p of HARBOR_PRODUCTS) {
      d().prepare("INSERT INTO products (id, business_id, name, description, price_cents, in_stock, sku) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), bid, p.name, p.description, p.priceCents, p.inStock, p.sku);
    }
    for (const platform of ["facebook", "instagram", "messenger", "whatsapp"] as const) {
      d().prepare("INSERT INTO connections (id, business_id, platform, mode, display_name, external_account_id, permissions_json, created_at) VALUES (?,?,?,?,?,?, '[]', ?)")
        .run(randomUUID(), bid, platform, "sandbox", `Harbor Goods on ${platform[0].toUpperCase() + platform.slice(1)} (Sandbox)`, `sbx_${platform}_harbor`, now());
    }
    audit("user:" + auth.sub, "demo_seeded", bid);
    return { businessId: bid, alreadySeeded: false };
  });

  // ---- deep seed: production-grade Harbor Goods dataset (synthetic) ----
  app.post("/api/demo/seed-deep", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { seedHarborDeep } = await import("../services/deep-seed.js");
    const result = seedHarborDeep(auth.sub);
    audit("user:" + auth.sub, "demo_seeded_deep", result.businessId);
    return result;
  });
}
