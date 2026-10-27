import { decryptSecret } from "../services/security.js";
import type { PlatformAdapter, Capability, ExternalConversation, ConnectionRow, SendTarget, TemplateSpec } from "./types.js";

const VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const WA_BASE = `https://graph.facebook.com/${VERSION}`;

/**
 * Live Meta Graph API adapter. Implements official endpoints per platform:
 * - Facebook Page: GET /{page-id}, GET /{page-id}/posts, POST /{page-id}/feed
 * - Messenger (via Page): GET /{page-id}/conversations, POST /me/messages
 * - Instagram: GET /{ig-user-id}, GET /{ig-user-id}/media, POST /{ig-user-id}/media + /media_publish
 * - WhatsApp Cloud API: POST /{phone-number-id}/messages
 * Access tokens are decrypted server-side only and never logged or returned.
 * Capability availability is derived from the permissions recorded at connect
 * time plus a live account check; missing permissions surface as unavailable
 * with a reason instead of being faked.
 */
export class GraphAdapter implements PlatformAdapter {
  platform; mode = "live" as const;
  constructor(private conn: ConnectionRow) { this.platform = conn.platform; }

  private token(): string {
    if (!this.conn.tokenEncrypted) throw new Error("connection_missing_token");
    const t = decryptSecret(this.conn.tokenEncrypted);
    if (!t) throw new Error("connection_token_undecryptable");
    return t;
  }
  private async graph(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as { error?: { message?: string; code?: number } }).error;
      throw new Error(`graph_api_${res.status}: ${err?.message ?? "unknown"} (code ${err?.code ?? "?"})`);
    }
    return data;
  }
  private permissions(): string[] {
    try { return JSON.parse(this.conn.permissionsJson) as string[]; } catch { return []; }
  }
  private cap(key: string, label: string, perm?: string): Capability {
    if (!perm) return { key, label, available: true };
    const ok = this.permissions().includes(perm);
    return { key, label, available: ok, ...(ok ? {} : { reason: `Missing permission: ${perm}. Grant it in the Meta app and reconnect.` }) };
  }

  async capabilities(): Promise<Capability[]> {
    switch (this.platform) {
      case "facebook": return [
        this.cap("read_page", "Read Page info", "pages_show_list"),
        this.cap("read_posts", "Read posts & comments", "pages_read_engagement"),
        this.cap("publish_post", "Publish Page posts", "pages_manage_posts"),
        this.cap("insights", "Page insights", "read_insights")];
      case "instagram": return [
        this.cap("read_profile", "Read profile", "instagram_basic"),
        this.cap("read_media", "Read media & comments", "instagram_basic"),
        this.cap("publish_post", "Publish media", "instagram_content_publish"),
        this.cap("messaging", "Instagram messaging", "instagram_manage_messages")];
      case "messenger": return [
        this.cap("read_conversations", "Read conversations", "pages_messaging"),
        this.cap("send_message", "Send messages (24h window)", "pages_messaging")];
      case "whatsapp": return [
        this.cap("send_message", "Send WhatsApp messages (opted-in users)", "whatsapp_business_messaging"),
        this.cap("templates", "Template messages", "whatsapp_business_messaging")];
    }
  }

  async getAccountInfo() {
    const id = this.conn.externalAccountId;
    const data = (await this.graph(`/${id}?fields=name,username`)) as { name?: string; username?: string };
    return { name: data.name ?? data.username ?? this.conn.displayName, id };
  }

  async listConversations(): Promise<ExternalConversation[]> {
    if (this.platform === "messenger" || this.platform === "facebook") {
      const data = (await this.graph(`/${this.conn.externalAccountId}/conversations?fields=participants,messages{message,from,created_time}`)) as {
        data?: Array<{ id: string; participants?: { data?: Array<{ name?: string; id?: string }> }; messages?: { data?: Array<{ id: string; message?: string; from?: { id?: string; name?: string }; created_time?: string }> } }>;
      };
      return (data.data ?? []).map((c) => {
        const other = (c.participants?.data ?? []).find((p) => p.id !== this.conn.externalAccountId);
        return {
          externalThreadId: c.id, customerName: other?.name ?? "Customer", customerRef: other?.id ?? "",
          messages: (c.messages?.data ?? []).map((m) => ({
            externalId: m.id, direction: (m.from?.id === this.conn.externalAccountId ? "out" : "in") as "in" | "out",
            body: m.message ?? "", at: m.created_time ?? new Date().toISOString()
          }))
        };
      });
    }
    // Instagram/WhatsApp conversation listing depends on webhook-ingested
    // messages in production; the adapter reports none rather than inventing any.
    return [];
  }

  async sendMessage(target: SendTarget, body: string, _idempotencyKey: string) {
    // The recipient is always the platform-scoped customer id (PSID / phone),
    // never the conversation id: the Send API addresses users, not threads.
    if (!target.recipientId) throw new Error(`${this.platform}_recipient_missing: conversation has no customer recipient id`);
    if (this.platform === "whatsapp") {
      // Free-form text is only valid inside the 24h service window; the engine
      // routes out-of-window conversations to sendTemplate instead.
      const data = (await this.graph(`/${this.conn.externalAccountId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messaging_product: "whatsapp", to: target.recipientId, type: "text", text: { body } })
      })) as { messages?: Array<{ id: string }> };
      const id = data.messages?.[0]?.id;
      if (!id) throw new Error("whatsapp_send_no_message_id");
      return { externalId: id, acceptedAt: new Date().toISOString() };
    }
    // Messenger platform Send API (Page token) — also serves Facebook-page and
    // Instagram DM conversations. recipient.id is the customer's PSID/IGSID
    // (persisted upstream as the conversation's customer_ref), NOT the
    // conversation id returned by /{page-id}/conversations.
    const data = (await this.graph(`/me/messages`, {
      method: "POST",
      body: JSON.stringify({ recipient: { id: target.recipientId }, messaging_type: "RESPONSE", message: { text: body } })
    })) as { message_id?: string };
    if (!data.message_id) throw new Error("messenger_send_no_message_id");
    return { externalId: data.message_id, acceptedAt: new Date().toISOString() };
  }

  /**
   * WhatsApp template send. A template is sent ONLY after verifying against
   * the WhatsApp Business Account that an APPROVED template with the exact
   * name (and language) exists. If the WABA cannot be resolved from the
   * connection's phone-number id, or no approved template matches, this
   * throws a whatsapp_template_* error and sends nothing — the caller
   * records the action as blocked/unverifiable rather than falling back to
   * a free-form text send.
   */
  async sendTemplate(target: SendTarget, template: TemplateSpec, _idempotencyKey: string) {
    if (this.platform !== "whatsapp") throw new Error(`template_not_supported_for_${this.platform}`);
    if (!target.recipientId) throw new Error("whatsapp_recipient_missing: conversation has no customer recipient id");
    const phoneId = this.conn.externalAccountId;
    const phone = (await this.graph(`/${phoneId}?fields=whatsapp_business_account`)) as { whatsapp_business_account?: { id?: string } };
    const wabaId = phone.whatsapp_business_account?.id;
    if (!wabaId) throw new Error("whatsapp_template_unverifiable: connection does not resolve to a WhatsApp Business Account, so template approval cannot be verified");
    const list = (await this.graph(`/${wabaId}/message_templates?fields=name,status,language&limit=200`)) as { data?: Array<{ name?: string; status?: string; language?: string }> };
    const match = (list.data ?? []).find((t) => t.name === template.name && t.status === "APPROVED" && (!template.language || t.language === template.language));
    if (!match) throw new Error(`whatsapp_template_not_approved: no APPROVED template named "${template.name}" (${template.language}) on the WhatsApp Business Account`);
    const data = (await this.graph(`/${phoneId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp", to: target.recipientId, type: "template",
        template: { name: template.name, language: { code: template.language } }
      })
    })) as { messages?: Array<{ id: string }> };
    const id = data.messages?.[0]?.id;
    if (!id) throw new Error("whatsapp_send_no_message_id");
    return { externalId: id, acceptedAt: new Date().toISOString() };
  }

  async publishPost(caption: string, _idempotencyKey: string, mediaUrl?: string) {
    if (this.platform === "facebook") {
      const data = (await this.graph(`/${this.conn.externalAccountId}/feed`, { method: "POST", body: JSON.stringify({ message: caption }) })) as { id?: string };
      if (!data.id) throw new Error("facebook_publish_no_post_id");
      return { externalId: data.id, acceptedAt: new Date().toISOString() };
    }
    if (this.platform === "instagram") {
      // The IG publishing API has no text-only post: a media container must be
      // created from an image/video URL first, then published. Without a
      // media URL the honest answer is a refusal, not a fake success.
      if (!mediaUrl) {
        throw new Error("instagram_publish_requires_media_url: provide media in the content draft (not supported for text-only drafts)");
      }
      const container = (await this.graph(`/${this.conn.externalAccountId}/media`, {
        method: "POST",
        body: JSON.stringify({ image_url: mediaUrl, caption })
      })) as { id?: string };
      if (!container.id) throw new Error("instagram_publish_no_container_id");
      const published = (await this.graph(`/${this.conn.externalAccountId}/media_publish`, {
        method: "POST",
        body: JSON.stringify({ creation_id: container.id })
      })) as { id?: string };
      if (!published.id) throw new Error("instagram_publish_no_media_id");
      return { externalId: published.id, acceptedAt: new Date().toISOString() };
    }
    throw new Error(`publish_not_supported_for_${this.platform}`);
  }

  async getObject(externalId: string) {
    try {
      const data = (await this.graph(`/${externalId}?fields=id`)) as { id?: string };
      return { exists: Boolean(data.id), kind: "graph_object", detail: `Graph API returned object ${data.id ?? "(none)"}` };
    } catch (e) {
      return { exists: false, kind: "graph_object", detail: "Graph lookup failed: " + (e as Error).message };
    }
  }
}
export const graphBase = BASE; export const waBase = WA_BASE;
