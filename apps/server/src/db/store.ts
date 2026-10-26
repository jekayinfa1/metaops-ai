import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// node:sqlite is loaded through createRequire: it is a Node >= 22 builtin
// that some bundlers/test transforms cannot resolve as an ESM import yet.
// At runtime this is the genuine built-in SQLite driver.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DatabaseSync = any;

/**
 * Persistence. Local development uses SQLite through Node's built-in driver
 * (no native dependencies); the schema is deliberately Postgres-compatible
 * (TEXT/INTEGER/REAL, ISO timestamps, JSON in TEXT columns) so the deployment
 * target in ARCHITECTURE.md (PostgreSQL) is a driver swap, not a redesign.
 */
let db: DatabaseSync;
export function getDb(): DatabaseSync {
  if (!db) {
    // METAOPS_DB (a directory) wins when set: the test suites use it to isolate
    // their databases; otherwise METAOPS_DATA_DIR, else ./data.
    const dir = process.env.METAOPS_DB || process.env.METAOPS_DATA_DIR || path.join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(path.join(dir, "metaops.db"));
    migrate(db);
  }
  return db;
}

function migrate(d: DatabaseSync) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    hours TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', return_policy TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT 'friendly and concise', escalation_contact TEXT NOT NULL DEFAULT '',
    faqs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER, currency TEXT NOT NULL DEFAULT 'USD', in_stock INTEGER NOT NULL DEFAULT 1, sku TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, platform TEXT NOT NULL, mode TEXT NOT NULL,
    display_name TEXT NOT NULL, external_account_id TEXT NOT NULL DEFAULT '',
    token_encrypted TEXT, token_expires_at TEXT, status TEXT NOT NULL DEFAULT 'connected',
    permissions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, connection_id TEXT NOT NULL, platform TEXT NOT NULL,
    external_thread_id TEXT NOT NULL, customer_name TEXT NOT NULL, customer_ref TEXT NOT NULL DEFAULT '',
    category TEXT, lead_status TEXT NOT NULL DEFAULT 'new', product_interest TEXT,
    suggested_reply TEXT, template_required INTEGER NOT NULL DEFAULT 0, classification_json TEXT, last_message_at TEXT NOT NULL,
    workflow_state TEXT NOT NULL DEFAULT 'new', UNIQUE(connection_id, external_thread_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, direction TEXT NOT NULL,
    body TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
    external_id TEXT, idempotency_key TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL, customer_name TEXT NOT NULL, category TEXT NOT NULL,
    product_interest TEXT, priority TEXT NOT NULL DEFAULT 'low', explanation TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new', follow_up_eligible INTEGER NOT NULL DEFAULT 0,
    last_contact_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, connection_id TEXT, platform TEXT NOT NULL,
    kind TEXT NOT NULL, caption TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    external_id TEXT, scheduled_for TEXT, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL,
    platform TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, user_id TEXT NOT NULL, objective TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'created', plan_json TEXT, models_json TEXT NOT NULL DEFAULT '[]',
    failure_reason TEXT, created_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS task_steps (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER NOT NULL, operation TEXT NOT NULL,
    platform TEXT, requires_approval INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT NOT NULL DEFAULT '', idempotency_key TEXT UNIQUE, attempts INTEGER NOT NULL DEFAULT 0,
    output_json TEXT, started_at TEXT, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ai_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, purpose TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
  -- Sandbox adapter platform state: objects the sandbox "platform" has accepted,
  -- independently queryable for verification (message ids, post ids).
  CREATE TABLE IF NOT EXISTS draft_audits (
    id TEXT PRIMARY KEY, task_id TEXT, entity_type TEXT NOT NULL, entity_ref TEXT,
    attempt INTEGER NOT NULL, ok INTEGER NOT NULL, violations_json TEXT NOT NULL DEFAULT '[]',
    injection_detected INTEGER NOT NULL DEFAULT 0, auditor_model TEXT NOT NULL, at TEXT NOT NULL
  );
    CREATE TABLE IF NOT EXISTS data_deletion_requests (
    id TEXT PRIMARY KEY, confirmation_code TEXT UNIQUE NOT NULL, external_user_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', received_at TEXT NOT NULL, completed_at TEXT, detail TEXT NOT NULL DEFAULT ''
  );
    CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY, user_id TEXT NOT NULL, business_id TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, business_id TEXT NOT NULL,
    pages_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sandbox_objects (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, kind TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  `);
  // Column migrations for databases created before the dual-pass auditor.
  try { d.exec("ALTER TABLE conversations ADD COLUMN template_required INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
}

export function audit(actor: string, event: string, detail = "") {
  getDb().prepare("INSERT INTO audit (at, actor, event, detail) VALUES (?,?,?,?)").run(new Date().toISOString(), actor, event, detail);
}
