import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

const RUN = Date.now();
let app: FastifyInstance;
let token: string;
let businessId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// Stubbed Graph transport: no network, no real app credentials.
function stubGraph(url: string) {
  const u = new URL(url);
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  if (u.pathname.endsWith("/oauth/access_token") && u.searchParams.has("code"))
    return ok({ access_token: "SHORT_USER_TOKEN" });
  if (u.pathname.endsWith("/oauth/access_token") && u.searchParams.has("fb_exchange_token"))
    return ok({ access_token: "LONG_USER_TOKEN", expires_in: 5184000 });
  if (u.pathname.endsWith("/me/accounts"))
    return ok({
      data: [
        { id: "111", name: "Harbor Test Page", category: "Shopping", access_token: "PAGE_TOKEN_A", perms: ["pages_messaging", "pages_read_engagement"], instagram_business_account: { id: "999", username: "harbortest" } },
        { id: "222", name: "Second Page", category: "Services", access_token: "PAGE_TOKEN_B", perms: [] }
      ]
    });
  if (u.pathname.endsWith("/debug_token")) {
    const input = u.searchParams.get("input_token");
    if (input === "PAGE_TOKEN_A")
      return ok({ data: { is_valid: true, expires_at: 1799999999, scopes: ["pages_messaging", "pages_read_engagement"], type: "PAGE" } });
    return ok({ data: { is_valid: false, expires_at: 0, scopes: [], type: "" } });
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: "unstubbed", code: 404 } }) };
}

beforeAll(async () => {
  const oauth = await import("../apps/server/src/services/oauth");
  oauth.setGraphFetchForTests(stubGraph as never);
  const server = await import("../apps/server/src/index");
  app = await server.buildApp();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `oauth-${RUN}@example.com`, password: "correct horse battery" } });
  token = reg.json().token;
  const biz = await app.inject({ method: "POST", url: "/api/businesses", headers: auth(token), payload: { name: `OAuth Biz ${RUN}` } });
  businessId = biz.json().business.id;
});

afterAll(async () => { await app.close(); });

describe("facebook oauth connect flow", () => {
  it("reports honestly when the app is not configured", async () => {
    delete process.env.META_APP_ID; delete process.env.META_APP_SECRET;
    const res = await app.inject({ method: "GET", url: `/api/oauth/facebook/start?businessId=${businessId}`, headers: auth(token) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("oauth_not_configured");
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET = "test-app-secret";
  });

  it("builds a dialog URL with state and the full scope set", async () => {
    const res = await app.inject({ method: "GET", url: `/api/oauth/facebook/start?businessId=${businessId}`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const { url, scopes } = res.json();
    expect(url).toContain("facebook.com/v21.0/dialog/oauth");
    expect(url).toContain("client_id=1234567890");
    expect(url).toContain("state=");
    expect(scopes).toContain("pages_messaging");
    expect(scopes).toContain("instagram_content_publish");
  });

  it("rejects an unknown or replayed state at the callback", async () => {
    const bad = await app.inject({ method: "GET", url: "/api/oauth/facebook/callback?code=X&state=nope" });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toContain("error=state_invalid");
  });

  let sessionId = "";
  it("completes the callback: exchanges tokens and stores an encrypted page session", async () => {
    const start = await app.inject({ method: "GET", url: `/api/oauth/facebook/start?businessId=${businessId}`, headers: auth(token) });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cb = await app.inject({ method: "GET", url: `/api/oauth/facebook/callback?code=GOOD&state=${state}` });
    expect(cb.statusCode).toBe(302);
    const loc = cb.headers.location as string;
    expect(loc).toContain("/oauth/facebook/done?session=");
    sessionId = new URLSearchParams(loc.split("?")[1]).get("session")!;
    // State is single-use:
    const replay = await app.inject({ method: "GET", url: `/api/oauth/facebook/callback?code=GOOD&state=${state}` });
    expect(replay.headers.location).toContain("error=state_invalid");
  });

  it("lists pages for the picker without ever exposing tokens", async () => {
    const res = await app.inject({ method: "GET", url: `/api/oauth/facebook/pages?session=${sessionId}`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("PAGE_TOKEN_A");
    expect(raw).not.toContain("PAGE_TOKEN_B");
    const { pages } = res.json();
    expect(pages).toHaveLength(2);
    expect(pages[0].instagram.id).toBe("999");
  });

  it("connects selected pages (plus linked Instagram) with encrypted tokens", async () => {
    const res = await app.inject({ method: "POST", url: "/api/oauth/facebook/connect", headers: auth(token), payload: { session: sessionId, pageIds: ["111"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().connected).toHaveLength(2); // facebook + instagram
    const conns = (await app.inject({ method: "GET", url: `/api/businesses/${businessId}/connections`, headers: auth(token) })).json().connections;
    const fb = conns.find((c: { platform: string }) => c.platform === "facebook");
    expect(fb.mode).toBe("live");
    expect(JSON.stringify(conns)).not.toContain("PAGE_TOKEN_A");
    // At rest: encrypted, decryptable only via the server-side key.
    const { getDb } = await import("../apps/server/src/db/store");
    const { decryptSecret } = await import("../apps/server/src/services/security");
    const row = getDb().prepare("SELECT token_encrypted FROM connections WHERE id=?").get(fb.id) as { token_encrypted: string };
    expect(row.token_encrypted).not.toContain("PAGE_TOKEN_A");
    expect(decryptSecret(row.token_encrypted)).toBe("PAGE_TOKEN_A");
    // Session is consumed:
    const again = await app.inject({ method: "POST", url: "/api/oauth/facebook/connect", headers: auth(token), payload: { session: sessionId, pageIds: ["222"] } });
    expect(again.statusCode).toBe(410);
  });

  it("reports token health via debug_token without leaking the token", async () => {
    const conns = (await app.inject({ method: "GET", url: `/api/businesses/${businessId}/connections`, headers: auth(token) })).json().connections;
    const fb = conns.find((c: { platform: string }) => c.platform === "facebook");
    const res = await app.inject({ method: "GET", url: `/api/connections/${fb.id}/token-health`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().isValid).toBe(true);
    expect(res.json().scopes).toContain("pages_messaging");
    expect(JSON.stringify(res.json())).not.toContain("PAGE_TOKEN_A");
  });
});
