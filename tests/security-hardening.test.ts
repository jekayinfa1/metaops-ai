import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.METAOPS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "metaops-sec-"));
process.env.METAOPS_SECRET = "security-hardening-test-secret-0123456789";
delete process.env.MODEL_API_KEY;

import { secretConfigurationError } from "../apps/server/src/services/security.js";

let app: Awaited<ReturnType<typeof import("../apps/server/src/index").buildApp>>;
const RUN = Date.now();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(email: string, password = "correct horse battery") {
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password } });
  return res;
}
async function login(email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
}

beforeAll(async () => {
  const server = await import("../apps/server/src/index");
  app = await server.buildApp();
});

describe("production secret policy (unit)", () => {
  it("refuses missing, default, and short secrets in production only", () => {
    expect(secretConfigurationError({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toMatch(/METAOPS_SECRET is not set/);
    expect(secretConfigurationError({ NODE_ENV: "production", METAOPS_SECRET: "metaops-local-dev-secret-change-me" } as NodeJS.ProcessEnv)).toMatch(/known development\/default/);
    expect(secretConfigurationError({ NODE_ENV: "production", METAOPS_SECRET: "short" } as NodeJS.ProcessEnv)).toMatch(/too short/);
    expect(secretConfigurationError({ NODE_ENV: "production", METAOPS_SECRET: "p".repeat(48) } as NodeJS.ProcessEnv)).toBeNull();
    expect(secretConfigurationError({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeNull();
    expect(secretConfigurationError({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("login rate limiting", () => {
  it("blocks after 15 failed attempts for the same IP+email, even for the right password", async () => {
    const email = `victim-${RUN}@example.com`;
    expect((await register(email)).statusCode).toBe(200);
    for (let i = 0; i < 15; i++) {
      expect((await login(email, "wrong password")).statusCode).toBe(401);
    }
    expect((await login(email, "wrong password")).statusCode).toBe(429);
    // The block is checked before credentials: even the correct password is refused while blocked.
    expect((await login(email, "correct horse battery")).statusCode).toBe(429);
    // A different account from the same IP is unaffected (key is IP+email).
    const other = `bystander-${RUN}@example.com`;
    expect((await register(other)).statusCode).toBe(200);
    expect((await login(other, "correct horse battery")).statusCode).toBe(200);
  });
});

describe("server-side session revocation", () => {
  it("logout kills the current session; logout-all kills every session", async () => {
    const email = `revoke-${RUN}@example.com`;
    const token1 = (await register(email)).json().token as string;
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token1) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth(token1) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token1) })).statusCode).toBe(401);

    const token2 = (await login(email, "correct horse battery")).json().token as string;
    const token3 = (await login(email, "correct horse battery")).json().token as string;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: auth(token2) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token2) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token3) })).statusCode).toBe(401);
  });

  it("change-password revokes all existing sessions and only the new password works", async () => {
    const email = `pwchange-${RUN}@example.com`;
    const token1 = (await register(email, "old password 123")).json().token as string;
    const token2 = (await login(email, "old password 123")).json().token as string;
    const bad = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: auth(token2), payload: { currentPassword: "not the password", newPassword: "new password 456" } });
    expect(bad.statusCode).toBe(401);
    const changed = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: auth(token2), payload: { currentPassword: "old password 123", newPassword: "new password 456" } });
    expect(changed.statusCode).toBe(200);
    const token3 = changed.json().token as string;
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token1) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token2) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token3) })).statusCode).toBe(200);
    expect((await login(email, "old password 123")).statusCode).toBe(401);
    expect((await login(email, "new password 456")).statusCode).toBe(200);
  });
});

describe("query-string tokens are restricted to the SSE route", () => {
  it("rejects ?token= on a normal API route but accepts the header", async () => {
    const email = `qt-${RUN}@example.com`;
    const token = (await register(email)).json().token as string;
    expect((await app.inject({ method: "GET", url: `/api/businesses?token=${token}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token) })).statusCode).toBe(200);
  });
});

describe("cross-user task mutation", () => {
  it("a stranger cannot pause, resume, cancel, or read another user's task", async () => {
    const ownerEmail = `taskowner-${RUN}@example.com`;
    const strangerEmail = `stranger-${RUN}@example.com`;
    const ownerToken = (await register(ownerEmail)).json().token as string;
    const strangerToken = (await register(strangerEmail)).json().token as string;
    const seed = await app.inject({ method: "POST", url: "/api/demo/seed", headers: auth(ownerToken) });
    const businessId = seed.json().businessId as string;
    const created = await app.inject({ method: "POST", url: `/api/businesses/${businessId}/tasks`, headers: auth(ownerToken), payload: { objective: "Security test task: summarize the inbox." } });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    for (const action of ["pause", "resume", "cancel"]) {
      const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/${action}`, headers: auth(strangerToken) });
      expect(res.statusCode, `stranger ${action}`).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: auth(strangerToken) })).statusCode).toBe(404);
    // The owner can still control it (and cancel stops the run).
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/pause`, headers: auth(ownerToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel`, headers: auth(ownerToken) })).statusCode).toBe(200);
  });
});

// Declared last: the per-IP registration limiter is shared by this file's app
// instance, so this test calibrates against whatever count came before it.
describe("registration rate limiting", () => {
  it("caps registrations per IP within the window", async () => {
    let ok = 0;
    let blocked = false;
    for (let i = 0; i < 40 && !blocked; i++) {
      const res = await register(`flood-${RUN}-${i}@example.com`);
      if (res.statusCode === 429) blocked = true;
      else if (res.statusCode === 200) ok++;
    }
    expect(blocked).toBe(true);
    expect(ok).toBeLessThanOrEqual(30);
  });
});
