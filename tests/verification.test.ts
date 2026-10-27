import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.METAOPS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "metaops-verif-"));
process.env.METAOPS_SECRET = "test-secret-for-verification-suite";
delete process.env.MODEL_API_KEY; // labelled demo-heuristic path, sandbox adapters

type ReceiptModule = typeof import("../apps/server/src/services/receipt");
type StoreModule = typeof import("../apps/server/src/db/store");
let receipt: ReceiptModule;
let store: StoreModule;
let app: Awaited<ReturnType<typeof import("../apps/server/src/index").buildApp>>;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const RUN = Date.now();

async function waitForTask(token: string, taskId: string, states: string[], timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: auth(token) });
    const t = res.json().task;
    if (states.includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("task did not reach " + states.join("|"));
}

beforeAll(async () => {
  receipt = await import("../apps/server/src/services/receipt");
  store = await import("../apps/server/src/db/store");
  const server = await import("../apps/server/src/index");
  app = await server.buildApp();
});

describe("verification taxonomy classifier", () => {
  // Lazy delegates: the module is imported in beforeAll (env must be set first).
  const classify: ReceiptModule["classifyExternalVerification"] = (input) => receipt.classifyExternalVerification(input);
  const rank: ReceiptModule["VERIFICATION_LEVEL_RANK"] = new Proxy({} as ReceiptModule["VERIFICATION_LEVEL_RANK"], {
    get: (_t, prop) => receipt.VERIFICATION_LEVEL_RANK[prop as keyof ReceiptModule["VERIFICATION_LEVEL_RANK"]]
  });

  it("Facebook Page publish with live read-back earns 'published' (platform_readback)", () => {
    const v = classify({ kind: "publish_post", platform: "facebook", mode: "live", phase: "accepted", externalId: "123_456", readBack: { exists: true, detail: "Graph API returned object 123_456" } });
    expect(v.level).toBe("published");
    expect(v.basis).toBe("platform_readback");
    expect(v.mode).toBe("live");
  });

  it("Instagram publish with live read-back earns 'published'", () => {
    const v = classify({ kind: "publish_post", platform: "instagram", mode: "live", phase: "accepted", externalId: "17900011122233344", readBack: { exists: true, detail: "Graph API returned object" } });
    expect(v.level).toBe("published");
    expect(v.basis).toBe("platform_readback");
  });

  it("Messenger send with live read-back earns 'object_confirmed', never 'delivered'", () => {
    const v = classify({ kind: "send_message", platform: "messenger", mode: "live", phase: "accepted", externalId: "m_abc", readBack: { exists: true, detail: "Graph API returned object m_abc" } });
    expect(v.level).toBe("object_confirmed");
    expect(v.basis).toBe("platform_readback");
  });

  it("Instagram send with live read-back earns 'object_confirmed'", () => {
    const v = classify({ kind: "send_message", platform: "instagram", mode: "live", phase: "accepted", externalId: "m_xyz", readBack: { exists: true, detail: "Graph API returned object m_xyz" } });
    expect(v.level).toBe("object_confirmed");
  });

  it("WhatsApp send caps at provider_id_returned when read-back does not confirm", () => {
    const v = classify({ kind: "send_message", platform: "whatsapp", mode: "live", phase: "accepted", externalId: "wamid.HBg", readBack: { exists: false, detail: "Graph lookup failed: unsupported" } });
    expect(v.level).toBe("provider_id_returned");
    expect(v.basis).toBe("provider_response");
    expect(v.evidence).toContain("did not confirm");
  });

  it("WhatsApp send without any read-back stays at provider_id_returned", () => {
    const v = classify({ kind: "send_template", platform: "whatsapp", mode: "live", phase: "accepted", externalId: "wamid.HBg", readBack: null });
    expect(v.level).toBe("provider_id_returned");
  });

  it("webhook evidence is the only route to delivered/read (live only)", () => {
    const d = classify({ kind: "send_message", platform: "whatsapp", mode: "live", phase: "accepted", externalId: "wamid.1", deliveryEvidence: "delivered" });
    expect(d.level).toBe("delivered");
    expect(d.basis).toBe("webhook_receipt");
    const r = classify({ kind: "send_message", platform: "messenger", mode: "live", phase: "accepted", externalId: "m_1", deliveryEvidence: "read" });
    expect(r.level).toBe("read");
    // The same claim in sandbox is impossible: sandbox has no webhooks.
    const s = classify({ kind: "send_message", platform: "whatsapp", mode: "sandbox", phase: "accepted", externalId: "sbx_1", deliveryEvidence: "delivered", readBack: { exists: true, detail: "sandbox object present" } });
    expect(s.level).toBe("object_confirmed");
    expect(s.mode).toBe("sandbox");
  });

  it("sandbox outcomes keep sandbox mode/basis at the same ladder rung", () => {
    const send = classify({ kind: "send_message", platform: "facebook", mode: "sandbox", phase: "accepted", externalId: "sbx_msg_1", readBack: { exists: true, detail: "sandbox object present" } });
    expect(send).toMatchObject({ level: "object_confirmed", basis: "sandbox_state", mode: "sandbox" });
    const pub = classify({ kind: "publish_post", platform: "facebook", mode: "sandbox", phase: "accepted", externalId: "sbx_post_1", readBack: { exists: true, detail: "sandbox object present" } });
    expect(pub).toMatchObject({ level: "published", basis: "sandbox_state", mode: "sandbox" });
  });

  it("accepted without an identifier is only provider_accepted", () => {
    const v = classify({ kind: "send_message", platform: "messenger", mode: "live", phase: "accepted", externalId: null });
    expect(v.level).toBe("provider_accepted");
  });

  it("ambiguous attempts are unverified with a reason, never upgraded", () => {
    const v = classify({ kind: "send_message", platform: "whatsapp", mode: "live", phase: "attempted_unknown", note: "Provider attempt outcome unknown (timeout). Not resent." });
    expect(v.level).toBe("unverified");
    expect(v.reason).toContain("outcome unknown");
  });

  it("blocked-before-attempt is unverified with basis none and a reason", () => {
    const v = classify({ kind: "send_template", platform: "whatsapp", mode: "live", phase: "not_attempted", note: "whatsapp_template_not_approved" });
    expect(v.level).toBe("unverified");
    expect(v.basis).toBe("none");
    expect(v.reason).toBeTruthy();
  });

  it("no adapter-evidence combination ever yields objective_verified, delivered, or read without webhooks", () => {
    const levels = new Set<string>();
    for (const kind of ["send_message", "send_template", "publish_post"] as const)
      for (const platform of ["facebook", "instagram", "messenger", "whatsapp"])
        for (const mode of ["live", "sandbox"] as const)
          for (const phase of ["not_attempted", "attempted_unknown", "accepted"] as const)
            for (const readBack of [null, { exists: true, detail: "ok" }, { exists: false, detail: "no" }])
              levels.add(classify({ kind, platform, mode, phase, externalId: "x1", readBack }).level);
    expect(levels.has("objective_verified")).toBe(false);
    expect(levels.has("delivered")).toBe(false);
    expect(levels.has("read")).toBe(false);
  });

  it("level ranks are monotonic with evidence strength", () => {
    expect(rank.unverified).toBeLessThan(rank.request_attempted);
    expect(rank.request_attempted).toBeLessThan(rank.provider_accepted);
    expect(rank.provider_accepted).toBeLessThan(rank.provider_id_returned);
    expect(rank.provider_id_returned).toBeLessThan(rank.object_confirmed);
    expect(rank.object_confirmed).toBe(rank.published);
    expect(rank.object_confirmed).toBeLessThan(rank.delivered);
    expect(rank.delivered).toBeLessThan(rank.read);
    expect(rank.read).toBeLessThan(rank.objective_verified);
  });
});

describe("receipt-level verification labels", () => {
  it("sandbox hero run: sends are object_confirmed/sandbox, publishes are published/sandbox, nothing claims live or webhook levels", async () => {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `verif-${RUN}@harbor.example`, password: "correct horse battery" } });
    const token = reg.json().token as string;
    const seed = await app.inject({ method: "POST", url: "/api/demo/seed", headers: auth(token) });
    const businessId = seed.json().businessId as string;
    const created = await app.inject({ method: "POST", url: `/api/businesses/${businessId}/tasks`, headers: auth(token), payload: { objective: "Run today's Meta business operations. Handle new customer inquiries, identify interested buyers, prepare tomorrow's promotion, and show me proof of what was completed." } });
    const taskId = created.json().task.id as string;
    await waitForTask(token, taskId, ["awaiting_approval", "completed", "partially_completed", "failed"]);
    for (let round = 0; round < 10; round++) {
      const approvals = (await app.inject({ method: "GET", url: `/api/approvals?businessId=${businessId}`, headers: auth(token) })).json().approvals;
      const pending = approvals.filter((a: { status: string; taskId: string }) => a.status === "pending" && a.taskId === taskId);
      if (!pending.length) {
        const t = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: auth(token) })).json().task;
        if (["completed", "partially_completed", "failed"].includes(t.state)) break;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      for (const a of pending) await app.inject({ method: "POST", url: `/api/approvals/${a.id}/approve`, headers: auth(token) });
      await new Promise((r) => setTimeout(r, 500));
    }
    const final = await waitForTask(token, taskId, ["completed", "partially_completed", "failed"], 20000);
    expect(final.state).toBe("completed");

    const rc = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/receipt`, headers: auth(token) })).json();
    const sends = rc.actions.filter((a: { operation: string; status: string }) => a.operation === "send_approved_replies" && a.status === "confirmed");
    expect(sends.length).toBeGreaterThanOrEqual(5);
    for (const s of sends) {
      expect(s.verification).toMatchObject({ level: "object_confirmed", basis: "sandbox_state", mode: "sandbox" });
      expect(s.verification.evidence).toContain("Sandbox");
    }
    const pubs = rc.actions.filter((a: { operation: string; status: string }) => a.operation === "publish_approved_content" && a.status === "confirmed");
    expect(pubs.length).toBeGreaterThanOrEqual(2);
    for (const p of pubs) expect(p.verification).toMatchObject({ level: "published", basis: "sandbox_state", mode: "sandbox" });
    // The honesty ceiling: no sandbox run may claim live, delivered, read, or objective-verified outcomes.
    for (const a of rc.actions) {
      if (!a.verification) continue;
      expect(a.verification.mode).not.toBe("live");
      expect(["delivered", "read", "objective_verified"]).not.toContain(a.verification.level);
    }
    // Auditor evidence: audit actions carry the exact draft that was judged.
    const audits = rc.actions.filter((a: { operation: string }) => a.operation === "audit_draft");
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a: { draft?: string }) => typeof a.draft === "string" && a.draft.length > 0)).toBe(true);
    // Integrity wording states the precise guarantee, and the checksum covers the verification fields.
    expect(rc.integrity.note).toContain("not a digital signature");
    expect(rc.integrity.note).toContain("does not prove who authored");
    expect(receipt.verifyReceiptIntegrity(rc)).toBe(true);
    const tampered = JSON.parse(JSON.stringify(rc));
    tampered.actions.find((a: { verification?: unknown }) => a.verification).verification.level = "objective_verified";
    expect(receipt.verifyReceiptIntegrity(tampered)).toBe(false);
  }, 90000);

  it("persisted stubbed-live evidence passes through the receipt with its honest labels unchanged", async () => {
    // Simulate the persisted step output of a Graph-backed run (stubbed
    // provider): a Messenger send confirmed by read-back, a WhatsApp send
    // the provider accepted but nothing stronger can prove, and an ambiguous
    // send whose outcome was never recorded.
    const d = store.getDb();
    const taskId = `stubbed-live-${RUN}`;
    const businessId = `biz-${RUN}`;
    d.prepare("INSERT INTO tasks (id, business_id, user_id, objective, state, models_json, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(taskId, businessId, "user-stub", "Handle inquiries (stubbed live run)", "completed", JSON.stringify(["muse-wonder-1.0", "muse-spark-1.3"]), new Date().toISOString(), new Date().toISOString());
    const actions = [
      { operation: "send_approved_replies", platform: "messenger", target: "Pat Q.", status: "confirmed", detail: "Platform read-back confirmed message m_111", externalId: "m_111",
        verification: receipt.classifyExternalVerification({ kind: "send_message", platform: "messenger", mode: "live", phase: "accepted", externalId: "m_111", readBack: { exists: true, detail: "Graph API returned object m_111" } }) },
      { operation: "send_approved_replies", platform: "whatsapp", target: "Sam R.", status: "confirmed", detail: "Platform accepted message wamid.222 but read-back did not confirm it.", externalId: "wamid.222",
        verification: receipt.classifyExternalVerification({ kind: "send_message", platform: "whatsapp", mode: "live", phase: "accepted", externalId: "wamid.222", readBack: { exists: false, detail: "Graph lookup failed" } }) },
      { operation: "send_approved_replies", platform: "whatsapp", target: "Jo T.", status: "accepted_unconfirmed", detail: "Provider attempt outcome unknown (timeout). Not resent.",
        verification: receipt.classifyExternalVerification({ kind: "send_message", platform: "whatsapp", mode: "live", phase: "attempted_unknown", note: "Provider attempt outcome unknown (timeout). Not resent." }) },
      { operation: "publish_approved_content", platform: "facebook", target: "facebook", status: "confirmed", detail: "Published and read-back confirmed in the platform (123_999).", externalId: "123_999",
        verification: receipt.classifyExternalVerification({ kind: "publish_post", platform: "facebook", mode: "live", phase: "accepted", externalId: "123_999", readBack: { exists: true, detail: "Graph API returned object 123_999" } }) }
    ];
    d.prepare("INSERT INTO task_steps (id, task_id, seq, operation, platform, status, detail, attempts, output_json) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(`step-${RUN}`, taskId, 1, "send_approved_replies", null, "completed", "4 replies processed", 1, JSON.stringify({ actions }));
    d.prepare("INSERT INTO approvals (id, business_id, task_id, kind, platform, summary, payload_json, payload_hash, status, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(`appr-${RUN}`, businessId, taskId, "send_message", "messenger", "Send reply", "{}", "a".repeat(64), "approved", new Date().toISOString(), new Date().toISOString());

    const rc = receipt.buildReceipt(taskId);
    expect(rc).not.toBeNull();
    const byTarget = new Map(rc!.actions.map((a) => [a.target, a]));
    expect(byTarget.get("Pat Q.")?.verification).toMatchObject({ level: "object_confirmed", basis: "platform_readback", mode: "live" });
    expect(byTarget.get("Sam R.")?.verification).toMatchObject({ level: "provider_id_returned", basis: "provider_response", mode: "live" });
    expect(byTarget.get("Jo T.")?.verification?.level).toBe("unverified");
    expect(byTarget.get("Jo T.")?.verification?.reason).toContain("outcome unknown");
    expect(byTarget.get("facebook")?.verification).toMatchObject({ level: "published", basis: "platform_readback", mode: "live" });
    expect(rc!.approvals[0].payloadHash).toBe("a".repeat(64));
    expect(receipt.verifyReceiptIntegrity(rc!)).toBe(true);
  });
});
