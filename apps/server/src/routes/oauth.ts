import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/store.js";
import { encryptSecret, decryptSecret, randomToken } from "../services/security.js";
import { requireAuth } from "./api.js";
import { oauthConfig, dialogUrl, exchangeCodeForUserToken, exchangeLongLivedUserToken, fetchUserPages, debugToken, OAUTH_SCOPES, type OAuthPage } from "../services/oauth.js";

const now = () => new Date().toISOString();
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;

export async function oauthRoutes(app: FastifyInstance) {
  const d = () => getDb();
  const audit = (actor: string, event: string, detail = "") =>
    d().prepare("INSERT INTO audit (at, actor, event, detail) VALUES (?,?,?,?)").run(now(), actor, event, detail);
  const webBase = () => (process.env.APP_WEB_BASE_URL || "").replace(/\/$/, "");

  // Start: returns the Facebook dialog URL for the signed-in owner.
  app.get("/api/oauth/facebook/start", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const cfg = oauthConfig();
    if (!cfg) return reply.code(503).send({ error: "oauth_not_configured", message: "Facebook connect is not configured on this server: the operator must set META_APP_ID and META_APP_SECRET (see META_APP_SETUP.md)." });
    const businessId = (req.query as { businessId?: string }).businessId;
    if (!businessId) return reply.code(400).send({ error: "business_required" });
    const biz = d().prepare("SELECT id FROM businesses WHERE id=? AND user_id=?").get(businessId, auth.sub);
    if (!biz) return reply.code(404).send({ error: "business_not_found" });
    const state = randomToken(24);
    d().prepare("INSERT INTO oauth_states (state, user_id, business_id, created_at, expires_at, used) VALUES (?,?,?,?,?,0)")
      .run(state, auth.sub, businessId, now(), new Date(Date.now() + STATE_TTL_MS).toISOString());
    audit("user:" + auth.sub, "oauth_start", businessId);
    return { url: dialogUrl(cfg, state), scopes: OAUTH_SCOPES };
  });

  // Callback: Facebook redirects the owner's browser here with ?code&state.
  app.get("/api/oauth/facebook/callback", async (req, reply) => {
    const done = (params: Record<string, string>) =>
      reply.redirect(`${webBase()}/oauth/facebook/done?${new URLSearchParams(params)}`);
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error || !code || !state) return done({ error: "oauth_denied" });
    const row = d().prepare("SELECT * FROM oauth_states WHERE state=?").get(state) as
      { user_id: string; business_id: string; expires_at: string; used: number } | undefined;
    if (!row || row.used || Date.parse(row.expires_at) < Date.now()) return done({ error: "state_invalid" });
    d().prepare("UPDATE oauth_states SET used=1 WHERE state=?").run(state); // single-use, even if the exchange fails
    const cfg = oauthConfig();
    if (!cfg) return done({ error: "oauth_not_configured" });
    try {
      const shortLived = await exchangeCodeForUserToken(cfg, code);
      const longLived = await exchangeLongLivedUserToken(cfg, shortLived);
      const pages = await fetchUserPages(cfg, longLived.token);
      if (!pages.length) return done({ error: "no_pages" });
      const sessionId = randomUUID();
      // Page tokens sit in this row for at most SESSION_TTL_MS; store them encrypted.
      const blob = encryptSecret(JSON.stringify({ pages, userTokenExpiresAt: longLived.expiresIn ? new Date(Date.now() + longLived.expiresIn * 1000).toISOString() : null }));
      d().prepare("INSERT INTO oauth_sessions (id, user_id, business_id, pages_json, created_at, expires_at, consumed) VALUES (?,?,?,?,?,?,0)")
        .run(sessionId, row.user_id, row.business_id, blob, now(), new Date(Date.now() + SESSION_TTL_MS).toISOString());
      audit("user:" + row.user_id, "oauth_pages_fetched", `${pages.length} page(s)`);
      return done({ session: sessionId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      audit("user:" + row.user_id, "oauth_exchange_failed", msg);
      // Surface the Graph/transport error class in server logs (never the code or secret).
      console.error("oauth_exchange_failed:", msg);
      return done({ error: "exchange_failed" });
    }
  });

  const loadSession = (req: { headers: Record<string, string | string[] | undefined> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, sessionId: string) => {
    const auth = requireAuth(req, reply); if (!auth) return null;
    const row = d().prepare("SELECT * FROM oauth_sessions WHERE id=? AND user_id=?").get(sessionId, auth.sub) as
      { business_id: string; pages_json: string; expires_at: string; consumed: number } | undefined;
    if (!row) { reply.code(404).send({ error: "session_not_found" }); return null; }
    if (row.consumed || Date.parse(row.expires_at) < Date.now()) { reply.code(410).send({ error: "session_expired" }); return null; }
    const plain = decryptSecret(row.pages_json);
    if (!plain) { reply.code(500).send({ error: "session_unreadable" }); return null; }
    const parsed = JSON.parse(plain) as { pages: OAuthPage[]; userTokenExpiresAt: string | null };
    return { auth, row, pages: parsed.pages, userTokenExpiresAt: parsed.userTokenExpiresAt };
  };

  // Page picker data: page names/ids only — tokens never leave the server.
  app.get("/api/oauth/facebook/pages", async (req, reply) => {
    const sessionId = (req.query as { session?: string }).session;
    if (!sessionId) return reply.code(400).send({ error: "session_required" });
    const s = loadSession(req, reply, sessionId); if (!s) return;
    return {
      businessId: s.row.business_id,
      pages: s.pages.map((p) => ({
        pageId: p.pageId, name: p.name, category: p.category, perms: p.perms,
        instagram: p.instagramId ? { id: p.instagramId, name: p.instagramName } : null
      }))
    };
  });

  // Connect the selected Pages as live connections (tokens encrypted at rest).
  app.post("/api/oauth/facebook/connect", async (req, reply) => {
    const body = (req.body ?? {}) as { session?: string; pageIds?: string[] };
    if (!body.session || !Array.isArray(body.pageIds) || !body.pageIds.length)
      return reply.code(400).send({ error: "session_and_pages_required" });
    const s = loadSession(req, reply, body.session); if (!s) return;
    const selected = s.pages.filter((p) => body.pageIds!.includes(p.pageId));
    if (!selected.length) return reply.code(400).send({ error: "no_matching_pages" });
    const created: Array<{ platform: string; externalAccountId: string; displayName: string }> = [];
    const upsert = (platform: string, externalId: string, displayName: string, token: string, perms: string[]) => {
      const existing = d().prepare("SELECT id FROM connections WHERE business_id=? AND platform=? AND external_account_id=?")
        .get(s.row.business_id, platform, externalId) as { id: string } | undefined;
      if (existing) {
        d().prepare("UPDATE connections SET token_encrypted=?, permissions_json=?, mode='live', status='connected', display_name=? WHERE id=?")
          .run(encryptSecret(token), JSON.stringify(perms), displayName, existing.id);
      } else {
        d().prepare("INSERT INTO connections (id, business_id, platform, mode, display_name, external_account_id, token_encrypted, permissions_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(randomUUID(), s.row.business_id, platform, "live", displayName, externalId, encryptSecret(token), JSON.stringify(perms), now());
      }
      created.push({ platform, externalAccountId: externalId, displayName });
    };
    const cfg = oauthConfig();
    for (const p of selected) {
      // p.perms carries Page *tasks* (MANAGE, CREATE_CONTENT...), not OAuth
      // scopes. Capability checks need the scopes, so ask Meta via
      // debug_token; fall back to the requested scope set if that fails.
      let perms: string[] = OAUTH_SCOPES;
      if (cfg) {
        try {
          const dbg = await debugToken(cfg, p.accessToken);
          if (dbg.scopes.length) perms = dbg.scopes;
        } catch { /* keep the fallback */ }
      }
      upsert("facebook", p.pageId, p.name, p.accessToken, perms);
      if (p.instagramId) upsert("instagram", p.instagramId, p.instagramName ? `@${p.instagramName}` : `${p.name} (Instagram)`, p.accessToken, perms);
    }
    d().prepare("UPDATE oauth_sessions SET consumed=1 WHERE id=?").run(body.session);
    audit("user:" + s.auth.sub, "oauth_connected", created.map((c) => `${c.platform}:${c.externalAccountId}`).join(","));
    return { connected: created };
  });

  // Token health via debug_token: validity, expiry, scopes. Never returns the token.
  app.get("/api/connections/:id/token-health", async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const cfg = oauthConfig();
    if (!cfg) return reply.code(503).send({ error: "oauth_not_configured" });
    const { id } = req.params as { id: string };
    const row = d().prepare("SELECT c.* FROM connections c JOIN businesses b ON b.id=c.business_id WHERE c.id=? AND b.user_id=?")
      .get(id, auth.sub) as { token_encrypted: string | null; mode: string } | undefined;
    if (!row) return reply.code(404).send({ error: "connection_not_found" });
    if (!row.token_encrypted) return { isValid: false, reason: "no_token_stored" };
    const token = decryptSecret(row.token_encrypted);
    if (!token) return { isValid: false, reason: "token_undecryptable" };
    try {
      const health = await debugToken(cfg, token);
      // Persist the scopes Meta actually reports: capability checks read
      // permissions_json, and the connect-time snapshot can hold Page tasks
      // (MANAGE, CREATE_CONTENT...) instead of OAuth scopes.
      const upd = health.scopes.length
        ? d().prepare("UPDATE connections SET token_expires_at=?, status=?, permissions_json=? WHERE id=?")
        : d().prepare("UPDATE connections SET token_expires_at=?, status=? WHERE id=?");
      if (health.scopes.length) upd.run(health.expiresAt, health.isValid ? "connected" : "token_invalid", JSON.stringify(health.scopes), id);
      else upd.run(health.expiresAt, health.isValid ? "connected" : "token_invalid", id);
      return { isValid: health.isValid, expiresAt: health.expiresAt, scopes: health.scopes, type: health.type };
    } catch (e) {
      return reply.code(502).send({ error: "debug_token_failed", message: e instanceof Error ? e.message : "unknown" });
    }
  });
}
