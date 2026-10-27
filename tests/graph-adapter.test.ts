import { describe, it, expect, beforeEach, afterEach } from "vitest";

process.env.METAOPS_SECRET = <redacted>
process.env.METAOPS_DB = process.env.METAOPS_DB || "/tmp/metaops-graph.db";
delete process.env.MODEL_API_KEY;

import { GraphAdapter } from "../apps/server/src/adapters/graph.js";
import { SandboxAdapter } from "../apps/server/src/adapters/sandbox.js";
import type { ConnectionRow } from "../apps/server/src/adapters/types.js";
import { encryptSecret } from "../apps/server/src/services/security.js";
import { executeExternalAction } from "../apps/server/src/services/engine.js";
import { getDb } from "../apps/server/src/db/store.js";

/**
 * Priority Two regression suite: live Graph adapter addressing, WhatsApp
 * template verification, Instagram media publishing, and the engine's
 * idempotency ledger. Global fetch is stubbed — no real network calls.
 */
const RUN = String(Date.now());
const PSID = `PSID-${RUN}`;
const CONV_ID = `CONV-${RUN}`;
const PAGE_ID = `PAGE-${RUN}`;
const PHONE_ID = `PHONE-${RUN}`;
const WABA_ID = `WABA-${RUN}`;
const CUST_PHONE = "15551234567";

interface FetchCall { url: string; method: string; body: Record<string, unknown> | undefined }
let calls: FetchCall[] = [];
let handler: (url: string) => Promise<unknown> = async () => ({});
const realFetch = globalThis.fetch;

const jsonRes = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data
});

beforeEach(() => {
  calls = [];
  handler = async () => jsonRes({});
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) as Record<string, unknown> : undefined });
    return handler(String(url));
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function liveConn(platform: ConnectionRow["platform"], externalAccountId: string): ConnectionRow {
  return {
    id: `conn-${platform}-${RUN}`, businessId: `biz-${RUN}`, platform, mode: "live",
    displayName: `Test ${platform}`, externalAccountId,
    tokenEncrypted: encryptSecret("test-token-" + RUN), tokenExpiresAt: null,
    status: "connected", permissionsJson: "[]"
  };
}
const posts = () => calls.filter((c) => c.method === "POST");

describe("GraphAdapter Messenger addressing", () => {
  it("posts a reply to /me/messages with recipient.id equal to the PSID, not the conversation id", async () => {
    handler = async () => jsonRes({ message_id: "mid-1" });
    const adapter = new GraphAdapter(liveConn("messenger", PAGE_ID));
    const res = await adapter.sendMessage({ threadId: CONV_ID, recipientId: PSID }, "Hello!", `k-${RUN}-1`);
    expect(res.externalId).toBe("mid-1");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toContain("/me/messages");
    const recipient = (posts()[0].body as { recipient: { id: string } }).recipient;
    expect(recipient.id).toBe(PSID);
    expect(recipient.id).not.toBe(CONV_ID);
  });

  it("refuses to send when the conversation has no recipient id", async () => {
    const adapter = new GraphAdapter(liveConn("messenger", PAGE_ID));
    await expect(adapter.sendMessage({ threadId: CONV_ID, recipientId: "" }, "Hello!", `k-${RUN}-2`))
      .rejects.toThrow(/recipient_missing/);
    expect(calls).toHaveLength(0);
  });
});

describe("GraphAdapter WhatsApp paths", () => {
  it("sends in-window free-form text to the customer phone number", async () => {
    handler = async () => jsonRes({ messages: [{ id: "wamid-1" }] });
    const adapter = new GraphAdapter(liveConn("whatsapp", PHONE_ID));
    const res = await adapter.sendMessage({ threadId: "wa_thread_x", recipientId: CUST_PHONE }, "In stock!", `k-${RUN}-3`);
    expect(res.externalId).toBe("wamid-1");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ messaging_product: "whatsapp", to: CUST_PHONE, type: "text" });
  });

  it("template path verifies an APPROVED template on the WABA, then sends type:template (never type:text)", async () => {
    handler = async (url) => {
      if (url.includes("fields=whatsapp_business_account")) return jsonRes({ whatsapp_business_account: { id: WABA_ID } });
      if (url.includes("/message_templates")) return jsonRes({ data: [{ name: "follow_up", status: "APPROVED", language: "en_US" }] });
      if (url.endsWith("/messages")) return jsonRes({ messages: [{ id: "wamid-t1" }] });
      return jsonRes({});
    };
    const adapter = new GraphAdapter(liveConn("whatsapp", PHONE_ID));
    const res = await adapter.sendTemplate({ threadId: "wa_thread_x", recipientId: CUST_PHONE }, { name: "follow_up", language: "en_US" }, `k-${RUN}-4`);
    expect(res.externalId).toBe("wamid-t1");
    expect(calls.some((c) => c.url.includes(`/${WABA_ID}/message_templates`))).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ type: "template", to: CUST_PHONE, template: { name: "follow_up", language: { code: "en_US" } } });
    expect(posts()[0].body).not.toHaveProperty("text");
  });

  it("blocks when no APPROVED matching template exists — and sends nothing", async () => {
    handler = async (url) => {
      if (url.includes("fields=whatsapp_business_account")) return jsonRes({ whatsapp_business_account: { id: WABA_ID } });
      if (url.includes("/message_templates")) return jsonRes({ data: [{ name: "follow_up", status: "PENDING", language: "en_US" }, { name: "other", status: "APPROVED", language: "en_US" }] });
      return jsonRes({});
    };
    const adapter = new GraphAdapter(liveConn("whatsapp", PHONE_ID));
    await expect(adapter.sendTemplate({ threadId: "wa_thread_x", recipientId: CUST_PHONE }, { name: "follow_up", language: "en_US" }, `k-${RUN}-5`))
      .rejects.toThrow(/whatsapp_template_not_approved/);
    expect(posts()).toHaveLength(0);
  });

  it("blocks as unverifiable when the connection cannot resolve a WABA — and sends nothing", async () => {
    handler = async (url) => {
      if (url.includes("fields=whatsapp_business_account")) return jsonRes({});
      return jsonRes({});
    };
    const adapter = new GraphAdapter(liveConn("whatsapp", PHONE_ID));
    await expect(adapter.sendTemplate({ threadId: "wa_thread_x", recipientId: CUST_PHONE }, { name: "follow_up", language: "en_US" }, `k-${RUN}-6`))
      .rejects.toThrow(/whatsapp_template_unverifiable/);
    expect(posts()).toHaveLength(0);
  });
});

describe("GraphAdapter Instagram publishing", () => {
  it("refuses a text-only publish (no media URL) without calling the API", async () => {
    const adapter = new GraphAdapter(liveConn("instagram", `IG-${RUN}`));
    await expect(adapter.publishPost("just a caption", `k-${RUN}-7`)).rejects.toThrow(/instagram_publish_requires_media_url/);
    expect(calls).toHaveLength(0);
  });

  it("publishes with a media URL via the container + media_publish two-step flow", async () => {
    handler = async (url) => {
      if (url.endsWith("/media")) return jsonRes({ id: "container-1" });
      if (url.endsWith("/media_publish")) return jsonRes({ id: "media-1" });
      return jsonRes({});
    };
    const adapter = new GraphAdapter(liveConn("instagram", `IG-${RUN}`));
    const res = await adapter.publishPost("New mugs", `k-${RUN}-8`, "https://example.com/mug.jpg");
    expect(res.externalId).toBe("media-1");
    expect(posts()).toHaveLength(2);
    expect(posts()[0].url).toContain("/media");
    expect(posts()[0].body).toMatchObject({ image_url: "https://example.com/mug.jpg", caption: "New mugs" });
    expect(posts()[1].url).toContain("/media_publish");
    expect(posts()[1].body).toMatchObject({ creation_id: "container-1" });
  });
});

describe("engine idempotency ledger (executeExternalAction)", () => {
  it("a duplicate execution with the same key performs exactly one provider POST and replays the outcome", async () => {
    handler = async () => jsonRes({ message_id: "mid-dup" });
    const adapter = new GraphAdapter(liveConn("messenger", PAGE_ID));
    const key = `ledger-${RUN}-dup`;
    const target = { threadId: CONV_ID, recipientId: PSID };
    const first = await executeExternalAction(key, { kind: "send_message", platform: "messenger" }, () => adapter.sendMessage(target, "hi", key));
    const second = await executeExternalAction(key, { kind: "send_message", platform: "messenger" }, () => adapter.sendMessage(target, "hi", key));
    expect(first).toMatchObject({ kind: "accepted", externalId: "mid-dup", replayed: false });
    expect(second).toMatchObject({ kind: "accepted", externalId: "mid-dup", replayed: true });
    expect(posts().filter((c) => c.url.includes("/me/messages"))).toHaveLength(1);
  });

  it("an ambiguous timeout does not resend: the retry reports unverified and the provider is not called again", async () => {
    let attempts = 0;
    const key = `ledger-${RUN}-timeout`;
    const fn = async () => { attempts++; throw new TypeError("fetch failed: socket timeout"); };
    const first = await executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn);
    expect(first.kind).toBe("unverified");
    const second = await executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn);
    expect(second.kind).toBe("unverified");
    expect(attempts).toBe(1);
    const row = getDb().prepare("SELECT status FROM action_executions WHERE idempotency_key=?").get(key) as { status: string };
    expect(row.status).toBe("attempted");
  });

  it("a provider 5xx is ambiguous too: no blind resend", async () => {
    let attempts = 0;
    const key = `ledger-${RUN}-5xx`;
    const fn = async () => { attempts++; throw new Error("graph_api_500: internal error"); };
    const first = await executeExternalAction(key, { kind: "send_message", platform: "whatsapp" }, fn);
    const second = await executeExternalAction(key, { kind: "send_message", platform: "whatsapp" }, fn);
    expect(first.kind).toBe("unverified");
    expect(second.kind).toBe("unverified");
    expect(attempts).toBe(1);
  });

  it("a definite 4xx refusal is recorded as failed and a later retry may re-attempt", async () => {
    let attempts = 0;
    const key = `ledger-${RUN}-4xx`;
    const fn = async () => { attempts++; if (attempts === 1) throw new Error("graph_api_400: invalid parameter"); return { externalId: "mid-retry", acceptedAt: new Date().toISOString() }; };
    await expect(executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn)).rejects.toThrow(/graph_api_400/);
    const second = await executeExternalAction(key, { kind: "send_message", platform: "messenger" }, fn);
    expect(second).toMatchObject({ kind: "accepted", externalId: "mid-retry" });
    expect(attempts).toBe(2);
  });
});

describe("SandboxAdapter parity", () => {
  it("records the recipient id on sends and a template object on template sends, deduped by key", async () => {
    const conn: ConnectionRow = {
      id: `sbx-conn-${RUN}`, businessId: `biz-${RUN}`, platform: "whatsapp", mode: "sandbox",
      displayName: "Sandbox WA", externalAccountId: "sbx_phone", tokenEncrypted: null,
      tokenExpiresAt: null, status: "connected", permissionsJson: "[]"
    };
    const adapter = new SandboxAdapter(conn);
    const target = { threadId: "wa_thread_1", recipientId: "wa_priya" };
    const sent = await adapter.sendMessage(target, "hello", `sbk-${RUN}-1`);
    const obj = await adapter.getObject(sent.externalId);
    expect(obj.exists).toBe(true);
    expect(obj.detail).toContain("wa_priya");
    const t1 = await adapter.sendTemplate(target, { name: "follow_up", language: "en_US" }, `sbk-${RUN}-2`);
    const t2 = await adapter.sendTemplate(target, { name: "follow_up", language: "en_US" }, `sbk-${RUN}-2`);
    expect(t2.externalId).toBe(t1.externalId);
    const tobj = await adapter.getObject(t1.externalId);
    expect(tobj.exists).toBe(true);
    expect(tobj.kind).toBe("template_message");
  });
});
