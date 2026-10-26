import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual, randomUUID, randomBytes } from "node:crypto";
import { getDb, audit } from "../db/store.js";

/**
 * Meta platform callbacks: webhook verification + event ingestion, and the
 * data-deletion callback required for App Review.
 *
 * Configuration (all server-side env, never logged):
 *   META_WEBHOOK_VERIFY_TOKEN — the token pasted into the Meta app console.
 *   META_APP_SECRET           — verifies X-Hub-Signature-256 and signed_request.
 *   PUBLIC_BASE_URL           — public origin used in deletion status URLs.
 *
 * Ingestion is deliberately narrow: inbound customer messages for Pages /
 * Instagram accounts / WhatsApp numbers that match a LIVE connection row
 * (matched by external_account_id: Page ID, IG account ID, or WhatsApp phone
 * number ID). Events for unknown accounts are acknowledged (200) and dropped,
 * so Meta does not retry-storm us for other apps' traffic. Redeliveries are
 * deduplicated by the provider message ID (messages.idempotency_key UNIQUE).
 *
 * Note on Meta's 30-second bot-response policy: the webhook returns 200
 * immediately and a classify/draft task can be started from the inbox, but an
 * automatic acknowledgement SEND is not enabled — MetaOps is approval-first.
 * Whether an instant auto-ack is required for App Review is tracked in
 * META_API_COMPLIANCE.md; it must never be enabled silently.
 */

const now = () => new Date().toISOString();

function verifyToken(): string | null { return process.env.META_WEBHOOK_VERIFY_TOKEN || null; }
function appSecret(): string | null { return process.env.META_APP_SECRET || null; }
function publicBase(): string { return (process.env.PUBLIC_BASE_URL || "http://localhost:8790").replace(/\/$/, ""); }

function signatureValid(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try { provided = Buffer.from(header.slice("sha256=".length), "hex"); } catch { return false; }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface InboundEvent {
  platform: "facebook" | "instagram" | "whatsapp";
  accountExternalId: string;   // Page ID / IG ID / WhatsApp phone number ID
  threadExternalId: string;    // PSID / IGSID / wa_id
  customerName: string;
  messageExternalId: string;   // mid / wamid
  text: string;
  at: string;                  // ISO timestamp
}

function parseEvents(payload: Record<string, unknown>): InboundEvent[] {
  const events: InboundEvent[] = [];
  const entries = Array.isArray(payload.entry) ? (payload.entry as Record<string, unknown>[]) : [];
  const obj = String(payload.object || "");
  for (const entry of entries) {
    // Messenger + Instagram share the messaging[] envelope.
    const messaging = Array.isArray(entry.messaging) ? (entry.messaging as Record<string, unknown>[]) : [];
    for (const m of messaging) {
      const message = (m.message ?? {}) as Record<string, unknown>;
      const text = typeof message.text === "string" ? message.text : "";
      const mid = typeof message.mid === "string" ? message.mid : "";
      if (!mid || !text) continue; // delivery/read receipts and echoes carry no text we ingest
      if (message.is_echo) continue;
      const sender = (m.sender ?? {}) as Record<string, unknown>;
      const recipient = (m.recipient ?? {}) as Record<string, unknown>;
      const platform = obj === "instagram" ? "instagram" : "facebook";
      events.push({
        platform,
        accountExternalId: String(recipient.id || entry.id || ""),
        threadExternalId: String(sender.id || ""),
        customerName: platform === "instagram" ? "Instagram customer" : "Messenger customer",
        messageExternalId: mid,
        text,
        at: new Date(typeof m.timestamp === "number" ? m.timestamp : Date.now()).toISOString()
      });
    }
    // WhatsApp uses changes[] with field="messages".
    const changes = Array.isArray(entry.changes) ? (entry.changes as Record<string, unknown>[]) : [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const value = (change.value ?? {}) as Record<string, unknown>;
      const metadata = (value.metadata ?? {}) as Record<string, unknown>;
      const contacts = Array.isArray(value.contacts) ? (value.contacts as Record<string, unknown>[]) : [];
      const nameByWaId = new Map<string, string>();
      for (const c of contacts) {
        const profile = (c.profile ?? {}) as Record<string, unknown>;
        if (typeof c.wa_id === "string" && typeof profile.name === "string") nameByWaId.set(c.wa_id, profile.name);
      }
      const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
      for (const msg of messages) {
        const textObj = (msg.text ?? {}) as Record<string, unknown>;
        const body = typeof textObj.body === "string" ? textObj.body : "";
        const id = typeof msg.id === "string" ? msg.id : "";
        const from = typeof msg.from === "string" ? msg.from : "";
        if (!id || !from || !body) continue;
        const tsSec = typeof msg.timestamp === "string" ? Number(msg.timestamp) : NaN;
        events.push({
          platform: "whatsapp",
          accountExternalId: String(metadata.phone_number_id || ""),
          threadExternalId: from,
          customerName: nameByWaId.get(from) || "WhatsApp customer",
          messageExternalId: id,
          text: body,
          at: Number.isFinite(tsSec) ? new Date(tsSec * 1000).toISOString() : now()
        });
      }
    }
  }
  return events;
}

function ingest(ev: InboundEvent): "inserted" | "duplicate" | "no_connection" {
  const d = getDb();
  const conn = d.prepare("SELECT * FROM connections WHERE mode='live' AND platform=? AND external_account_id=?")
    .get(ev.platform, ev.accountExternalId) as Record<string, unknown> | undefined;
  if (!conn) return "no_connection";
  const convId = ((): string => {
    const existing = d.prepare("SELECT id FROM conversations WHERE connection_id=? AND external_thread_id=?")
      .get(String(conn.id), ev.threadExternalId) as { id: string } | undefined;
    if (existing) {
      d.prepare("UPDATE conversations SET last_message_at=?, workflow_state='new' WHERE id=?").run(ev.at, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    d.prepare(`INSERT INTO conversations (id, business_id, connection_id, platform, external_thread_id, customer_name, customer_ref, last_message_at, workflow_state)
                VALUES (?,?,?,?,?,?,?,?, 'new')`)
      .run(id, String(conn.business_id), String(conn.id), ev.platform, ev.threadExternalId, ev.customerName, ev.threadExternalId, ev.at);
    return id;
  })();
  const res = d.prepare(`INSERT OR IGNORE INTO messages (id, conversation_id, direction, body, at, status, external_id, idempotency_key)
                         VALUES (?,?, 'inbound', ?, ?, 'received', ?, ?)`)
    .run(randomUUID(), convId, ev.text, ev.at, ev.messageExternalId, `wh:${ev.messageExternalId}`) as unknown as { changes: number };
  return res.changes > 0 ? "inserted" : "duplicate";
}

export async function webhookRoutes(app: FastifyInstance) {
  // Scoped parsers keep the exact raw body available for HMAC verification.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(null, {}); }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    const params = new URLSearchParams(body as string);
    done(null, Object.fromEntries(params.entries()));
  });

  // ---- Webhook verification handshake (GET) ----
  app.get("/webhooks/meta", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const expected = verifyToken();
    if (!expected) return reply.code(503).send({ error: "webhook_not_configured" });
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === expected && q["hub.challenge"]) {
      return reply.code(200).type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send({ error: "verification_failed" });
  });

  // ---- Webhook event ingestion (POST) ----
  app.post("/webhooks/meta", async (req, reply) => {
    const secret = appSecret();
    if (!secret) return reply.code(503).send({ error: "webhook_not_configured" });
    const rawBody = (req as unknown as { rawBody?: string }).rawBody || "";
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!signatureValid(rawBody, sig, secret)) return reply.code(401).send({ error: "invalid_signature" });
    const payload = (req.body ?? {}) as Record<string, unknown>;
    let inserted = 0, duplicates = 0, unmatched = 0;
    for (const ev of parseEvents(payload)) {
      const r = ingest(ev);
      if (r === "inserted") inserted++; else if (r === "duplicate") duplicates++; else unmatched++;
    }
    audit("meta-webhook", "events_received", JSON.stringify({ inserted, duplicates, unmatched }));
    return reply.code(200).send({ received: true, inserted, duplicates, unmatched });
  });

  // ---- Data deletion callback (required for App Review) ----
  app.post("/api/meta/data-deletion", async (req, reply) => {
    const secret = appSecret();
    if (!secret) return reply.code(503).send({ error: "deletion_callback_not_configured" });
    const signed = (req.body as Record<string, unknown>)?.signed_request;
    if (typeof signed !== "string" || !signed.includes(".")) return reply.code(400).send({ error: "invalid_signed_request" });
    const [encodedSig, encodedPayload] = signed.split(".", 2);
    const expected = createHmac("sha256", secret).update(encodedPayload, "utf8").digest();
    let provided: Buffer;
    try { provided = base64UrlDecode(encodedSig); } catch { return reply.code(400).send({ error: "invalid_signed_request" }); }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return reply.code(400).send({ error: "invalid_signature" });
    }
    let data: Record<string, unknown>;
    try { data = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Record<string, unknown>; }
    catch { return reply.code(400).send({ error: "invalid_payload" }); }
    if (data.algorithm !== "HMAC-SHA256") return reply.code(400).send({ error: "unsupported_algorithm" });
    const externalUserId = String(data.user_id || "");
    const d = getDb();
    // Delete what can be matched to this app-scoped user ID: conversations where
    // the customer ref equals it, plus anything on connections registered to it.
    const convs = d.prepare(`SELECT c.id FROM conversations c
        LEFT JOIN connections cn ON cn.id = c.connection_id
        WHERE c.customer_ref = ? OR cn.external_account_id = ?`).all(externalUserId, externalUserId) as { id: string }[];
    for (const c of convs) {
      d.prepare("DELETE FROM messages WHERE conversation_id=?").run(c.id);
      d.prepare("DELETE FROM leads WHERE conversation_id=?").run(c.id);
      d.prepare("DELETE FROM conversations WHERE id=?").run(c.id);
    }
    const code = randomBytes(8).toString("hex");
    d.prepare(`INSERT INTO data_deletion_requests (id, confirmation_code, external_user_id, status, received_at, completed_at, detail)
               VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), code, externalUserId, "completed", now(), now(), JSON.stringify({ conversationsDeleted: convs.length }));
    audit("meta-data-deletion", "processed", JSON.stringify({ externalUserId, conversationsDeleted: convs.length, code }));
    return { url: `${publicBase()}/api/meta/data-deletion/status?code=${code}`, confirmation_code: code };
  });

  app.get("/api/meta/data-deletion/status", async (req, reply) => {
    const code = (req.query as Record<string, string>).code;
    if (!code) return reply.code(400).send({ error: "missing_code" });
    const row = getDb().prepare("SELECT confirmation_code, status, received_at, completed_at FROM data_deletion_requests WHERE confirmation_code=?")
      .get(code) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "unknown_confirmation_code" });
    return { confirmation_code: row.confirmation_code, status: row.status, received_at: row.received_at, completed_at: row.completed_at };
  });
}
