import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { buildApp } from "../apps/server/src/index.js";
import { getDb } from "../apps/server/src/db/store.js";

process.env.METAOPS_DB = process.env.METAOPS_DB || "/tmp/metaops-live.db";
process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
process.env.META_APP_SECRET = "test-app-secret";
delete process.env.MODEL_API_KEY;

let app: Awaited<ReturnType<typeof buildApp>>;
let token = "";
let businessId = "";
const RUN = String(Date.now());
const CONN_PAGE = `conn-page-${RUN}`;
const CONN_WA = `conn-wa-${RUN}`;
const PAGE = `PAGE-${RUN}`;
const PHONE = `PHONE-${RUN}`;

const sign = (raw: string) => "sha256=" + createHmac("sha256", "test-app-secret").update(raw, "utf8").digest("hex");
const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const MID1 = `mid-${RUN}-1`;
const PSID = `PSID-${RUN}`;
function pagePayload(mid: string, text: string, pageId: string = PAGE) {
  return JSON.stringify({
    object: "page",
    entry: [{
      id: pageId, time: Date.now(),
      messaging: [{ sender: { id: PSID }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } }]
    }]
  });
}

beforeAll(async () => {
  app = await buildApp();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `lr_${Date.now()}@example.com`, password: "password123" } });
  token = (reg.json() as { token: string }).token;
  const biz = await app.inject({ method: "POST", url: "/api/businesses", headers: { authorization: `Bearer ${token}` }, payload: { name: "Live Readiness Co" } });
  businessId = (biz.json() as { business: { id: string } }).business.id;
  // Live connections as they would exist after the Meta app setup (tokens omitted here; ingestion does not need them).
  const d = getDb();
  const ins = d.prepare("INSERT INTO connections (id, business_id, platform, mode, display_name, external_account_id, status, permissions_json, created_at) VALUES (?,?,?,?,?,?, 'connected', '[]', ?)");
  ins.run(CONN_PAGE, businessId, "facebook", "live", "Test Page", PAGE, new Date().toISOString());
  ins.run(CONN_WA, businessId, "whatsapp", "live", "Test WA", PHONE, new Date().toISOString());
});

describe("webhook verification handshake", () => {
  it("echoes the challenge for the correct verify token", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CH42" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("CH42");
  });
  it("rejects a wrong verify token", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CH42" });
    expect(res.statusCode).toBe(403);
  });
});

describe("webhook event ingestion", () => {
  it("ingests a signed Messenger event into the live connection's inbox", async () => {
    const raw = pagePayload(MID1, "Do you have the Anchor Mug in stock?");
    const res = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "x-hub-signature-256": sign(raw), "content-type": "application/json" }, payload: raw });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { inserted: number }).inserted).toBe(1);
    const conv = getDb().prepare("SELECT * FROM conversations WHERE connection_id=?").get(CONN_PAGE) as Record<string, unknown>;
    expect(conv).toBeTruthy();
    expect(conv.external_thread_id).toBe(PSID);
    const msgs = getDb().prepare("SELECT * FROM messages WHERE conversation_id=?").all(conv.id as string) as Record<string, unknown>[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toContain("Anchor Mug");
  });
  it("deduplicates Meta redeliveries of the same message", async () => {
    const raw = pagePayload(MID1, "Do you have the Anchor Mug in stock?");
    const res = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "x-hub-signature-256": sign(raw), "content-type": "application/json" }, payload: raw });
    expect((res.json() as { duplicates: number }).duplicates).toBe(1);
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE external_id=?").get(MID1) as { n: number };
    expect(count.n).toBe(1);
  });
  it("rejects an invalid signature and ingests nothing", async () => {
    const raw = pagePayload("mid-evil", "forged");
    const res = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64), "content-type": "application/json" }, payload: raw });
    expect(res.statusCode).toBe(401);
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE external_id='mid-evil'").get() as { n: number };
    expect(count.n).toBe(0);
  });
  it("ingests a WhatsApp messages change with the contact name", async () => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "WABA1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: PHONE },
            contacts: [{ wa_id: "15551234567", profile: { name: "Jamie Rivera" } }],
            messages: [{ id: `wamid.${RUN}.1`, from: "15551234567", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Is the Trail Backpack waterproof?" } }]
          }
        }]
      }]
    });
    const res = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "x-hub-signature-256": sign(raw), "content-type": "application/json" }, payload: raw });
    expect((res.json() as { inserted: number }).inserted).toBe(1);
    const conv = getDb().prepare("SELECT * FROM conversations WHERE connection_id=?").get(CONN_WA) as Record<string, unknown>;
    expect(conv.customer_name).toBe("Jamie Rivera");
    expect(conv.platform).toBe("whatsapp");
  });
  it("acknowledges events for unknown accounts without ingesting them", async () => {
    const raw = pagePayload("mid-other", "hello from another app", "OTHERPAGE-X");
    const res = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "x-hub-signature-256": sign(raw), "content-type": "application/json" }, payload: raw });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { unmatched: number }).unmatched).toBe(1);
  });
});

describe("data deletion callback", () => {
  it("verifies signed_request, returns url + confirmation_code, and reports status", async () => {
    const payloadJson = JSON.stringify({ user_id: PSID, algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000) });
    const encodedPayload = b64url(payloadJson);
    const sigBuf = createHmac("sha256", "test-app-secret").update(encodedPayload, "utf8").digest();
    const sigB64url = sigBuf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await app.inject({ method: "POST", url: "/api/meta/data-deletion", payload: { signed_request: `${sigB64url}.${encodedPayload}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toBeTruthy();
    expect(body.url).toContain(body.confirmation_code);
    const status = await app.inject({ method: "GET", url: `/api/meta/data-deletion/status?code=${body.confirmation_code}` });
    expect((status.json() as { status: string }).status).toBe("completed");
    // The test customer's conversation messages were deleted by the callback.
    const remaining = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE external_id=?").get(MID1) as { n: number };
    expect(remaining.n).toBe(0);
  });
  it("rejects a signed_request with a bad signature", async () => {
    const encodedPayload = b64url(JSON.stringify({ user_id: "X", algorithm: "HMAC-SHA256", issued_at: 1 }));
    const res = await app.inject({ method: "POST", url: "/api/meta/data-deletion", payload: { signed_request: `${b64url("fakesig")}.${encodedPayload}` } });
    expect(res.statusCode).toBe(400);
  });
});

describe("model API verification endpoint", () => {
  it("honestly reports not_configured when no key is set", async () => {
    const res = await app.inject({ method: "POST", url: "/api/ai/verify", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; status: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("not_configured");
  });
});
