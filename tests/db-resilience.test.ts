import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.METAOPS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "metaops-dbtest-"));
process.env.METAOPS_SECRET = "test-secret<redacted>";

// Regression coverage for the 2026-10-26 production crash: a SQLITE_BUSY
// ("database is locked") thrown inside the task engine escaped as an
// unhandled rejection and terminated the whole server during a live run.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as any;

describe("database resilience", () => {
  it("opens the database in WAL mode with a busy timeout", async () => {
    const { getDb } = await import("../apps/server/src/db/store");
    const db = getDb();
    const mode = db.prepare("PRAGMA journal_mode").get();
    expect(Object.values(mode)[0]).toBe("wal");
    const timeout = db.prepare("PRAGMA busy_timeout").get();
    expect(Number(Object.values(timeout)[0])).toBe(5000);
  });

  it("a write waits out a brief external lock instead of throwing SQLITE_BUSY", async () => {
    const { getDb } = await import("../apps/server/src/db/store");
    const db = getDb();
    const file = path.join(process.env.METAOPS_DATA_DIR!, "metaops.db");
    db.exec("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)");
    // The lock must be released from a CHILD PROCESS: node:sqlite is
    // synchronous, so a timer on this thread could never fire while the
    // write is blocked waiting (that is exactly what the busy timeout is
    // for). The child holds an exclusive lock for ~300ms of wall time.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const ext = new DatabaseSync(${JSON.stringify(file)});
      ext.exec("BEGIN EXCLUSIVE");
      setTimeout(() => { ext.exec("COMMIT"); ext.close(); }, 300);
    `], { stdio: "ignore" });
    // Give the child a moment to actually take the lock before writing.
    await new Promise((r) => setTimeout(r, 250));
    const t0 = Date.now();
    // With busy_timeout=5000 this blocks ~300ms and then succeeds; without it
    // the same call threw ERR_SQLITE_ERROR immediately (the crash above).
    db.prepare("INSERT INTO lock_probe (x) VALUES (1)").run();
    // An uncontended insert takes ~1ms; anything >=50ms proves the write
    // waited on the lock instead of throwing. (Observed ~144ms; the exact
    // figure depends on when the child took the lock, so assert loosely.)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    await new Promise((r) => child.on("exit", r));
  });
});
