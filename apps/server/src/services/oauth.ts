/**
 * Facebook Login OAuth for Page connections.
 *
 * Flow: dialog (code) -> short-lived user token -> long-lived user token ->
 * /me/accounts (Pages with long-lived Page tokens) -> the owner picks Pages ->
 * connections created with tokens encrypted at rest. Tokens are never returned
 * to clients. Graph calls go through an injectable fetch so tests can stub the
 * transport without any network or real app credentials.
 */

export const OAUTH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_manage_posts",
  "read_insights",
  "instagram_basic",
  "instagram_manage_messages",
  "instagram_content_publish"
];

export interface OAuthConfig { appId: string; appSecret: string; redirectUri: string; graphBase: string; version: string }

export function oauthConfig(): OAuthConfig | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    redirectUri: process.env.META_OAUTH_REDIRECT_URI || "http://localhost:8891/api/oauth/facebook/callback",
    graphBase: (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, ""),
    version: process.env.GRAPH_API_VERSION || "v21.0"
  };
}

export function dialogUrl(cfg: OAuthConfig, state: string): string {
  const u = new URL(`https://www.facebook.com/${cfg.version}/dialog/oauth`);
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", OAUTH_SCOPES.join(","));
  return u.toString();
}

// Injectable transport (tests replace this; production uses global fetch).
export type GraphFetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
let graphFetch: GraphFetch = (url) => fetch(url);
export function setGraphFetchForTests(fn: GraphFetch | null) { graphFetch = fn ?? ((url) => fetch(url)); }

async function graphGet(cfg: OAuthConfig, pathAndQuery: string): Promise<Record<string, unknown>> {
  const res = await graphFetch(`${cfg.graphBase}/${cfg.version}/${pathAndQuery}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || body.error) {
    const err = (body.error ?? {}) as { message?: string; code?: number };
    throw new Error(`graph_error_${err.code ?? res.status}: ${err.message ?? "Graph request failed"}`);
  }
  return body;
}

export async function exchangeCodeForUserToken(cfg: OAuthConfig, code: string): Promise<string> {
  const q = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri, code });
  const body = await graphGet(cfg, `oauth/access_token?${q}`);
  if (!body.access_token) throw new Error("graph_error_no_token: code exchange returned no access_token");
  return body.access_token as string;
}

export async function exchangeLongLivedUserToken(cfg: OAuthConfig, shortLived: string): Promise<{ token: string; expiresIn: number | null }> {
  const q = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: shortLived });
  const body = await graphGet(cfg, `oauth/access_token?${q}`);
  if (!body.access_token) throw new Error("graph_error_no_token: long-lived exchange returned no access_token");
  return { token: body.access_token as string, expiresIn: typeof body.expires_in === "number" ? body.expires_in : null };
}

export interface OAuthPage {
  pageId: string;
  name: string;
  category: string;
  accessToken: string;
  perms: string[];
  instagramId: string | null;
  instagramName: string | null;
}

export async function fetchUserPages(cfg: OAuthConfig, userToken: string): Promise<OAuthPage[]> {
  const q = new URLSearchParams({
    access_token: userToken,
    fields: "id,name,category,access_token,perms,instagram_business_account{id,name,username}"
  });
  const body = await graphGet(cfg, `me/accounts?${q}`);
  const data = (body.data ?? []) as Array<Record<string, unknown>>;
  return data.map((p) => {
    const ig = (p.instagram_business_account ?? null) as { id?: string; name?: string; username?: string } | null;
    return {
      pageId: String(p.id),
      name: String(p.name ?? "Unnamed Page"),
      category: String(p.category ?? ""),
      accessToken: String(p.access_token ?? ""),
      perms: Array.isArray(p.perms) ? (p.perms as unknown[]).map(String) : [],
      instagramId: ig?.id ? String(ig.id) : null,
      instagramName: ig ? String(ig.username ?? ig.name ?? "") : null
    };
  });
}

export interface DebugTokenResult {
  isValid: boolean;
  expiresAt: string | null;
  scopes: string[];
  type: string;
}

export async function debugToken(cfg: OAuthConfig, token: string): Promise<DebugTokenResult> {
  const appAccessToken = `${cfg.appId}|${cfg.appSecret}`;
  const q = new URLSearchParams({ input_token: token, access_token: appAccessToken });
  const body = await graphGet(cfg, `debug_token?${q}`);
  const data = (body.data ?? {}) as { is_valid?: boolean; expires_at?: number; scopes?: string[]; type?: string };
  return {
    isValid: Boolean(data.is_valid),
    expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
    scopes: data.scopes ?? [],
    type: String(data.type ?? "")
  };
}
