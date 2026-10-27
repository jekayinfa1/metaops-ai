import { describe, it, expect, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Production boot must FAIL CLOSED: with NODE_ENV=production the built server
 * refuses to start when METAOPS_SECRET is missing/empty, a known development
 * default, or too short — and boots normally with a strong secret.
 * Each case spawns the real built server on a scratch port with a scratch DB.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRONG_SECRET = "production-boot-test-" + "s".repeat(40);

beforeAll(() => {
  execSync("npm run build", { cwd: ROOT, stdio: "pipe", timeout: 280_000 });
}, 300_000);

function spawnServer(extraEnv: Record<string, string>, port: number) {
  const dbDir = mkdtempSync(path.join(tmpdir(), "metaops-boot-db-"));
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      METAOPS_DB: dbDir,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.on("data", (c) => { output += String(c); });
  child.stderr?.on("data", (c) => { output += String(c); });
  return { child, output: () => output };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function expectRefusal(extraEnv: Record<string, string>, port: number, messagePart: RegExp) {
  const { child, output } = spawnServer(extraEnv, port);
  const code = await waitForExit(child, 30_000);
  if (code === null) { child.kill("SIGKILL"); throw new Error("server did not exit: it booted despite an insecure production secret"); }
  expect(code).not.toBe(0);
  expect(output()).toMatch(/METAOPS_SECRET/);
  expect(output()).toMatch(messagePart);
}

describe("production boot secret enforcement", () => {
  it("refuses to boot when METAOPS_SECRET is empty", async () => {
    await expectRefusal({ METAOPS_SECRET: "" }, 18991, /not set/);
  }, 60_000);

  it("refuses to boot with the known development default", async () => {
    await expectRefusal({ METAOPS_SECRET: "metaops-local-dev-secret-change-me" }, 18992, /known development\/default/);
  }, 60_000);

  it("refuses to boot with a too-short secret", async () => {
    await expectRefusal({ METAOPS_SECRET: "short-secret" }, 18993, /too short/);
  }, 60_000);

  it("boots and serves /health with a strong secret", async () => {
    const { child } = spawnServer({ METAOPS_SECRET: STRONG_SECRET }, 18994);
    try {
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        try {
          const res = await fetch("http://127.0.0.1:18994/health");
          const body = await res.json() as { ok?: boolean };
          ok = res.status === 200 && body.ok === true;
        } catch { /* not up yet */ }
        if (!ok) await new Promise((r) => setTimeout(r, 500));
      }
      expect(ok).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10_000);
    }
  }, 60_000);
});
