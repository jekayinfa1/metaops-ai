import type { Platform } from "@metaops/shared";

export interface Capability { key: string; label: string; available: boolean; reason?: string }
export interface ExternalConversation {
  externalThreadId: string; customerName: string; customerRef: string;
  messages: Array<{ externalId: string; direction: "in" | "out"; body: string; at: string }>;
}
export interface SendResult { externalId: string; acceptedAt: string }
export interface PublishResult { externalId: string; acceptedAt: string }

/**
 * Who a send targets. The identifiers are NOT interchangeable and travel
 * together so no layer has to guess which one a platform API wants:
 * - threadId: the platform conversation/thread id (Messenger conversation id,
 *   WhatsApp thread id). Used for bookkeeping and read-back, NEVER as the
 *   Send API recipient.
 * - recipientId: the platform-scoped recipient — the customer's page-scoped
 *   user id (PSID) for Messenger/Facebook/Instagram messaging, the customer's
 *   phone number for WhatsApp. This is what Meta's send endpoints address.
 * The page/account id lives on the connection (externalAccountId), and the
 * provider's message id comes back in SendResult.externalId.
 */
export interface SendTarget { threadId: string; recipientId: string }

/** A pre-approved WhatsApp template to send (name + language as approved on the WABA). */
export interface TemplateSpec { name: string; language: string }

/**
 * One adapter per platform per connection. Adapters are the ONLY code that
 * talks to Meta platform APIs. The AI engine never calls platforms directly;
 * it calls these narrow, validated operations through the task engine.
 */
export interface PlatformAdapter {
  platform: Platform;
  mode: "sandbox" | "live";
  capabilities(): Promise<Capability[]>;
  getAccountInfo(): Promise<{ name: string; id: string }>;
  listConversations(): Promise<ExternalConversation[]>;
  /** Free-form message send. For WhatsApp this is only valid inside the 24h service window. */
  sendMessage(target: SendTarget, body: string, idempotencyKey: string): Promise<SendResult>;
  /** Template message send (WhatsApp). Adapters must verify the template before sending. */
  sendTemplate(target: SendTarget, template: TemplateSpec, idempotencyKey: string): Promise<SendResult>;
  publishPost(caption: string, idempotencyKey: string, mediaUrl?: string): Promise<PublishResult>;
  /** Independent verification: fetch an object back from the platform side. */
  getObject(externalId: string): Promise<{ exists: boolean; kind: string; detail: string }>;
}

export interface ConnectionRow {
  id: string; businessId: string; platform: Platform; mode: "sandbox" | "live";
  displayName: string; externalAccountId: string; tokenEncrypted: string | null;
  tokenExpiresAt: string | null; status: string; permissionsJson: string;
}
