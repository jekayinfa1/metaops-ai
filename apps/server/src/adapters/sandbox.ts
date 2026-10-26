import { randomUUID } from "node:crypto";
import { getDb } from "../db/store.js";
import type { PlatformAdapter, Capability, ExternalConversation, ConnectionRow } from "./types.js";
import { HARBOR_CONVERSATIONS } from "../services/seed-data.js";

/**
 * Sandbox adapter: a fully functional stand-in for a platform connection,
 * used when live Meta app review / permissions are unavailable during the
 * hackathon. It behaves like a platform (accepts sends/publishes, returns
 * platform object IDs, supports read-back verification) against isolated
 * sandbox state, and is ALWAYS labelled mode:"sandbox" end to end.
 * It never touches real Meta APIs or real customers.
 */
/** Fault injection (tests/demos): queue an error for the next listConversations() on a connection. */
export const sandboxFaults = new Map<string, Error[]>();
export function injectSandboxFault(connectionId: string, err: Error) {
  const q = sandboxFaults.get(connectionId) ?? [];
  q.push(err);
  sandboxFaults.set(connectionId, q);
}

export class SandboxAdapter implements PlatformAdapter {
  platform; mode = "sandbox" as const;
  constructor(private conn: ConnectionRow) { this.platform = conn.platform; }

  async capabilities(): Promise<Capability[]> {
    return [
      { key: "read_conversations", label: "Read conversations", available: true },
      { key: "send_message", label: "Send messages (sandbox)", available: true },
      { key: "publish_post", label: "Publish posts (sandbox)", available: this.platform === "facebook" || this.platform === "instagram" },
      { key: "insights", label: "Insights", available: false, reason: "Sandbox adapter does not simulate insights" },
      { key: "live_customers", label: "Real customers", available: false, reason: "Sandbox uses synthetic Harbor Goods data only" }
    ];
  }
  async getAccountInfo() { return { name: this.conn.displayName, id: this.conn.externalAccountId || "sbx_account" }; }

  async listConversations(): Promise<ExternalConversation[]> {
    const faults = sandboxFaults.get(this.conn.id);
    if (faults?.length) throw faults.shift()!;
    // The seed's message stamps are fixed calendar dates from when the seed was
    // authored; rebase them so the newest message is "now". Relative ages are
    // preserved, so threads never decay out of the 24h messaging window as real
    // time passes (that decay silently broke the hero workflow test).
    const newest = Math.max(...HARBOR_CONVERSATIONS.flatMap((c) => c.messages.map((m) => Date.parse(m.at))));
    const shift = Date.now() - newest;
    const rebase = (at: string) => new Date(Date.parse(at) + shift).toISOString();
    return HARBOR_CONVERSATIONS.filter((c) => c.platform === this.platform).map((c) => ({
      externalThreadId: c.externalThreadId, customerName: c.customerName, customerRef: c.customerRef,
      messages: c.messages.map((m) => ({ externalId: m.externalId, direction: m.direction, body: m.body, at: rebase(m.at) }))
    }));
  }

  async sendMessage(threadExternalId: string, body: string, idempotencyKey: string) {
    const d = getDb();
    const existing = d.prepare("SELECT id FROM sandbox_objects WHERE id=?").get("sbx_msg_" + idempotencyKey) as { id: string } | undefined;
    if (existing) return { externalId: existing.id, acceptedAt: new Date().toISOString() };
    const id = "sbx_msg_" + idempotencyKey;
    d.prepare("INSERT INTO sandbox_objects (id, connection_id, kind, payload_json, created_at) VALUES (?,?,?,?,?)")
      .run(id, this.conn.id, "message", JSON.stringify({ threadExternalId, body }), new Date().toISOString());
    return { externalId: id, acceptedAt: new Date().toISOString() };
  }

  async publishPost(caption: string, idempotencyKey: string) {
    const d = getDb();
    const id = "sbx_post_" + idempotencyKey;
    const existing = d.prepare("SELECT id FROM sandbox_objects WHERE id=?").get(id);
    if (!existing) {
      d.prepare("INSERT INTO sandbox_objects (id, connection_id, kind, payload_json, created_at) VALUES (?,?,?,?,?)")
        .run(id, this.conn.id, "post", JSON.stringify({ caption }), new Date().toISOString());
    }
    return { externalId: id, acceptedAt: new Date().toISOString() };
  }

  async getObject(externalId: string) {
    const row = getDb().prepare("SELECT kind, payload_json FROM sandbox_objects WHERE id=? AND connection_id=?").get(externalId, this.conn.id) as { kind: string; payload_json: string } | undefined;
    if (!row) return { exists: false, kind: "unknown", detail: `sandbox has no object ${externalId}` };
    return { exists: true, kind: row.kind, detail: `sandbox object present: ${row.payload_json.slice(0, 160)}` };
  }
}
export const newSandboxId = () => randomUUID();
