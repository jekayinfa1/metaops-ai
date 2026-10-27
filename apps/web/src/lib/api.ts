// MetaOps AI API client. The session token lives in localStorage; Meta
// platform access tokens NEVER reach the browser - they stay encrypted
// server-side.
//
// Session-storage posture (known, documented residual risk): a localStorage
// token is readable by any JavaScript running on this origin, so an XSS hole
// would expose it. Containments in place: sessions expire after 8 hours and
// are registered server-side, so they can be revoked at any time — sign-out
// kills the current session, and a password change or "sign out everywhere"
// kills all of them (see the authApi helpers below). The remaining exposure
// is bounded to one revocable 8-hour session; a full migration to httpOnly
// cookie sessions is the recorded follow-up, not yet done.

export const TOKEN_KEY = "metaops_token";
export const BUSINESS_KEY = "metaops_business_id";

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t: string | null) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === "object" && body && "error" in (body as Record<string, unknown>)
      ? String((body as Record<string, unknown>).error) : `Request failed (${status})`);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {})
    }
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) => req<T>(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(p: string, body?: unknown) => req<T>(p, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(p: string) => req<T>(p, { method: "DELETE" })
};

// Session management against the server-side session registry. Server-side
// revocation is the point: clearing localStorage alone never invalidated a
// token before, now logout actually kills the session server-side too.
export const authApi = {
  async logout(): Promise<void> {
    try { await api.post("/api/auth/logout"); } finally { setToken(null); }
  },
  async logoutAll(): Promise<void> {
    try { await api.post("/api/auth/logout-all"); } finally { setToken(null); }
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await api.post<{ token: string }>("/api/auth/change-password", { currentPassword, newPassword });
    setToken(res.token); // every older session was revoked; adopt the fresh one
  }
};

// ---------- shared shapes (mirrors the server contract) ----------
export type Platform = "facebook" | "instagram" | "messenger" | "whatsapp";

export interface AiStatus { configured: boolean; primaryModel: string; fallbackModel: string | null }

export interface Business {
  id: string; name: string; description?: string; hours?: string; location?: string;
  returnPolicy?: string; tone?: string; escalationContact?: string;
  faqs?: Array<{ q: string; a: string }>;
  [k: string]: unknown;
}
export interface Product { id: string; name: string; price?: number | string; description?: string; sku?: string; [k: string]: unknown }

export interface Capability { key: string; label: string; available: boolean; reason?: string }
export interface Connection {
  id: string; platform: Platform; mode: "sandbox" | "live"; displayName: string;
  externalAccountId?: string; capabilities: Capability[]; status: string;
}
export interface Conversation {
  id: string; platform: Platform; customerName: string; category: string;
  leadStatus: string; lastMessageAt: string; workflowState: string; suggestedReply?: string;
}
export interface Message { id: string; direction: "inbound" | "outbound"; body: string; at: string; status: string }
export interface Lead {
  id: string; platform: Platform; customerName: string; category: string;
  productInterest?: string; priority: string; explanation: string; status: string; followUpEligible: boolean;
}
export interface ContentItem {
  id: string; platform: Platform; kind: string; caption: string;
  status: "draft" | "approved" | "scheduled" | "published" | "failed" | "unverified";
  externalId?: string | null; scheduledFor?: string | null; mode?: "sandbox" | "live";
}
export interface Approval {
  id: string; kind: string; platform: Platform; summary: string;
  payload: Record<string, unknown>; payloadHash: string;
  status: "pending" | "approved" | "rejected" | "invalidated"; createdAt: string;
  businessId?: string; mode?: "sandbox" | "live"; accountName?: string;
}
export interface TaskStep { operation: string; status: string; detail?: string; platform?: string; requiresApproval?: boolean }
export interface Task {
  id: string; businessId: string; objective: string; state: string;
  createdAt?: string; finishedAt?: string | null; plan?: { steps: TaskStep[] } | null;
  failureReason?: string | null; [k: string]: unknown;
}
export interface ActivityReceipt {
  taskId: string; businessId: string; objective: string; startedAt: string; finishedAt: string | null;
  finalStatus: string;
  actions: Array<{ operation: string; platform?: string; target: string; status: string; detail: string; externalId?: string }>;
  approvals: Array<{ kind: string; at: string; decision: string; payloadHash: string }>;
  recoveries: Array<{ step: string; attempt: number; reason: string; at: string }>;
  modelsUsed: string[];
  usage: { aiCalls: number; inputTokens: number; outputTokens: number; approxCostUsd: number };
  integrity: { algorithm: string; receiptHash: string; note: string };
}

export const HERO_OBJECTIVE =
  "Run today's Meta business operations. Handle new customer inquiries, identify interested buyers, prepare tomorrow's promotion, and show me proof of what was completed.";

export function fmtTime(iso?: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
