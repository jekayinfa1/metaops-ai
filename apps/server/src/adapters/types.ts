import type { Platform } from "@metaops/shared";

export interface Capability { key: string; label: string; available: boolean; reason?: string }
export interface ExternalConversation {
  externalThreadId: string; customerName: string; customerRef: string;
  messages: Array<{ externalId: string; direction: "in" | "out"; body: string; at: string }>;
}
export interface SendResult { externalId: string; acceptedAt: string }
export interface PublishResult { externalId: string; acceptedAt: string }

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
  sendMessage(threadExternalId: string, body: string, idempotencyKey: string): Promise<SendResult>;
  publishPost(caption: string, idempotencyKey: string): Promise<PublishResult>;
  /** Independent verification: fetch an object back from the platform side. */
  getObject(externalId: string): Promise<{ exists: boolean; kind: string; detail: string }>;
}

export interface ConnectionRow {
  id: string; businessId: string; platform: Platform; mode: "sandbox" | "live";
  displayName: string; externalAccountId: string; tokenEncrypted: string | null;
  tokenExpiresAt: string | null; status: string; permissionsJson: string;
}
