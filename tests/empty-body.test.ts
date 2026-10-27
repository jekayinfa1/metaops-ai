import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Regression: the web client's fetch wrapper ALWAYS sends
// "Content-Type: application/json", including for action POSTs that carry no
// body at all (api.post(path) with no payload). Fastify's default JSON parser
// rejects a zero-length JSON body with 400 FST_ERR_CTP_EMPTY_JSON_BODY, so
// those calls silently failed in the UI — verified live for Operator
// Pause/Resume during demo filming (2026-10-26); the identical client pattern
// covers task pause/resume/cancel, approval approve/reject, and
// logout/logout-all. The API scope now parses an empty JSON body as {}
// (mirroring the webhook scope's parser), while malformed JSON still 400s.
process.env.METAOPS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "metaops-emptybody-"));
process.env.METAOPS_SECRET = "empty-body-test-secret-0123456789abcdef";
delete process.env.MODEL_API_KEY;

import { getDb } from "../apps/server/src/db/store.js";
import { payloadHash } from "../apps/server/src/services/security.js";

let app: Awaited<ReturnType<typeof import("../apps/server/src/index").buildApp>>;
const RUN = Date.now();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
// The browser's exact shape for a no-body action call: JSON content type, zero bytes.
const emptyJson = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

let ownerToken: string;
let ownerId: string;
let businessId: string;

function insertTask(state = "created"): string {
  const id = randomUUID();
  getDb().prepare("INSERT INTO tasks (id, business_id, user_id, objective, state, created_at) VALUES (?,?,?,?,?,?)")
    .run(id, businessId, ownerId, "empty-body regression fixture", state, new Date().toISOString());
  return id;
}
function insertApproval(): string {
  const id = randomUUID();
  const payload = { conversationId: "fixture-conv", body: "fixture reply" };
  getDb().prepare(`INSERT INTO approvals (id, business_id, task_id, kind, platform, summary, payload_json, payload_hash, status, created_at)
                   VALUES (?,?,NULL,'send_message','messenger','fixture approval',?,?, 'pending', ?)`)
    .run(id, businessId, JSON.stringify(payload), payloadHash(payload), new Date().toISOString());
  return id;
}
const taskState = (id: string) => (getDb().prepare("SELECT state FROM tasks WHERE id=?").get(id) as { state: string }).state;
const approvalStatus = (id: string) => (getDb().prepare("SELECT status FROM approvals WHERE id=?").get(id) as { status: string }).status;

async function registerUser(tag: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `${tag}-${RUN}@example.com`, password: "correct horse battery" } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}
async function loginUser(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "correct horse battery" } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

beforeAll(async () => {
  const server = await import("../apps/server/src/index");
  app = await server.buildApp();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `eb-owner-${RUN}@example.com`, password: "correct horse battery" } });
  expect(reg.statusCode).toBe(200);
  ownerToken = reg.json().token as string;
  ownerId = reg.json().userId as string;
  const biz = await app.inject({ method: "POST", url: "/api/businesses", headers: auth(ownerToken), payload: { name: "Empty Body Fixtures", description: "" } });
  expect(biz.statusCode).toBe(200);
  businessId = biz.json().business.id as string;
});

describe("no-body action endpoints accept an empty JSON body", () => {
  it("task pause: no-content-type control and empty-JSON both succeed", async () => {
    const control = insertTask();
    expect((await app.inject({ method: "POST", url: `/api/tasks/${control}/pause`, headers: auth(ownerToken) })).statusCode).toBe(200);
    const id = insertTask();
    const res = await app.inject({ method: "POST", url: `/api/tasks/${id}/pause`, headers: emptyJson(ownerToken), payload: "" });
    expect(res.statusCode).toBe(200);
    expect(taskState(id)).toBe("paused");
  });

  it("task resume: no-content-type control and empty-JSON both succeed", async () => {
    const control = insertTask("paused");
    expect((await app.inject({ method: "POST", url: `/api/tasks/${control}/resume`, headers: auth(ownerToken) })).statusCode).toBe(200);
    const id = insertTask("paused");
    const res = await app.inject({ method: "POST", url: `/api/tasks/${id}/resume`, headers: emptyJson(ownerToken), payload: "" });
    expect(res.statusCode).toBe(200);
  });

  it("task cancel: no-content-type control and empty-JSON both succeed", async () => {
    const control = insertTask();
    expect((await app.inject({ method: "POST", url: `/api/tasks/${control}/cancel`, headers: auth(ownerToken) })).statusCode).toBe(200);
    const id = insertTask();
    const res = await app.inject({ method: "POST", url: `/api/tasks/${id}/cancel`, headers: emptyJson(ownerToken), payload: "" });
    expect(res.statusCode).toBe(200);
    expect(taskState(id)).toBe("cancelled");
  });

  it("approval approve: no-content-type control and empty-JSON both succeed", async () => {
    const control = insertApproval();
    expect((await app.inject({ method: "POST", url: `/api/approvals/${control}/approve`, headers: auth(ownerToken) })).statusCode).toBe(200);
    const id = insertApproval();
    const res = await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: emptyJson(ownerToken), payload: "" });
    expect(res.statusCode).toBe(200);
    expect(approvalStatus(id)).toBe("approved");
  });

  it("approval reject: no-content-type control and empty-JSON both succeed", async () => {
    const control = insertApproval();
    expect((await app.inject({ method: "POST", url: `/api/approvals/${control}/reject`, headers: auth(ownerToken) })).statusCode).toBe(200);
    const id = insertApproval();
    const res = await app.inject({ method: "POST", url: `/api/approvals/${id}/reject`, headers: emptyJson(ownerToken), payload: "" });
    expect(res.statusCode).toBe(200);
    expect(approvalStatus(id)).toBe("rejected");
  });

  it("logout: no-content-type control succeeds and revokes the session", async () => {
    const token = await registerUser("eb-logout-ctl");
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token) })).statusCode).toBe(401);
  });

  it("logout (empty JSON) succeeds and revokes the calling session", async () => {
    const token = await registerUser("eb-logout-json");
    const res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: emptyJson(token), payload: "" });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(token) })).statusCode).toBe(401);
  });

  it("logout-all: no-content-type control and empty-JSON both succeed and revoke every session", async () => {
    const tag = "eb-logoutall";
    const email = `${tag}-${RUN}@example.com`;
    const t1 = await registerUser(tag);
    const t2 = await loginUser(email);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: auth(t1) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(t2) })).statusCode).toBe(401);
    const t3 = await loginUser(email);
    const t4 = await loginUser(email);
    const res = await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: emptyJson(t3), payload: "" });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/businesses", headers: auth(t4) })).statusCode).toBe(401);
  });
});

describe("parser invariants around the fix", () => {
  it("a genuinely malformed JSON body still returns 400 (action endpoint)", async () => {
    const id = insertTask();
    const res = await app.inject({ method: "POST", url: `/api/tasks/${id}/pause`, headers: emptyJson(ownerToken), payload: "{not-json" });
    expect(res.statusCode).toBe(400);
    expect(taskState(id)).toBe("created"); // handler never ran
  });

  it("a genuinely malformed JSON body still returns 400 (body-consuming endpoint)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/businesses", headers: emptyJson(ownerToken), payload: "{bad" });
    expect(res.statusCode).toBe(400);
  });

  it("an empty JSON body reaches body-consuming handlers as {} (their own validation error, not a parser error)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/businesses", headers: emptyJson(ownerToken), payload: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_business");
  });

  it("valid JSON bodies still parse normally", async () => {
    const res = await app.inject({ method: "POST", url: "/api/businesses", headers: emptyJson(ownerToken), payload: { name: "Still Parses", description: "ok" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().business.name).toBe("Still Parses");
  });
});
