import { describe, it, expect, beforeEach, afterEach } from "vitest";

process.env.METAOPS_SECRET = ["test", "secret", "ai", "client"].join("-");
process.env.METAOPS_DB = "/tmp/metaops-ai-client.db";
process.env.MODEL_API_KEY = ["test", "api", "key", "not", "real"].join("-");

import { classifyMessage, draftReply, draftContent, auditDraft, planObjective, verifyModelApi, approxCostUsd, type BusinessContext } from "../apps/server/src/services/ai.js";

/**
 * Priority Five regression suite: the Meta Model API client (ai.ts) against
 * a stubbed fetch — no real network calls. Pins the request contract verified
 * against Meta's official Responses API documentation and live probe calls
 * on 2026-10-26 (see AI_USAGE.md):
 *  - POST https://api.meta.ai/v1/responses with { model, input[] } where
 *    input items are { role, content: [{ type: "input_text", text }] }
 *  - output text is read from output[] items of type "message" whose content
 *    contains type "output_text" (reasoning items precede the message)
 *  - every request carries a stable per-purpose prompt_cache_key and
 *    prompt_cache_retention "24h" so the static facts prefix is served from
 *    the server prompt cache on repeats (live probe: 0 cached tokens without
 *    the key; 94-99% cached with it)
 *  - non-2xx responses throw meta_api_<status> with the provider body,
 *    which is how the recorded 402 billing_not_configured surfaces.
 */
const realFetch = globalThis.fetch;
interface FetchCall { url: string; body: Record<string, unknown>; headers: Record<string, string> }
let calls: FetchCall[] = [];
let responder: (url: string) => { status: number; payload: unknown } = () => ({ status: 200, payload: {} });

const responseWith = (text: string) => ({
  id: "resp_test",
  output: [
    { type: "reasoning", id: "rs_test", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  ],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 150 },
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url: String(url), body, headers: init.headers ?? {} });
    const { status, payload } = responder(String(url));
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const ctx: BusinessContext = {
  name: "Harbor Goods", description: "Goods store", hours: "9-7", location: "Houston",
  returnPolicy: "30 days", tone: "warm", faqs: [{ q: "Gift wrap?", a: "Free." }],
  products: [{ name: "Harbor Candle", description: "Candle", priceCents: 2400, inStock: true }],
};

describe("Meta Model API client request contract", () => {
  it("classify: Spark model, typed input items, per-purpose cache key", async () => {
    responder = () => ({ status: 200, payload: responseWith(JSON.stringify({ category: "pricing", leadPotential: "medium", explanation: "Asks price.", productInterest: "Harbor Candle" })) });
    const { classification, model } = await classifyMessage("task-test", "How much is the Harbor Candle?", ["Harbor Candle"]);
    expect(model).toBe("muse-spark-1.3");
    expect(classification.category).toBe("pricing");
    expect(calls).toHaveLength(1);
    const { url, body } = calls[0];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect(body.model).toBe("muse-spark-1.3");
    expect(body.prompt_cache_key).toBe("metaops-classify");
    expect(body.prompt_cache_retention).toBe("24h");
    const input = body.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(input.map((i) => i.role)).toEqual(["system", "user"]);
    expect(input.every((i) => i.content.every((c) => c.type === "input_text"))).toBe(true);
    expect(input[1].content[0].text).toContain("Business products: Harbor Candle");
  });

  it("draft_reply: Wonder model and metaops-draft_reply cache key; facts precede the message", async () => {
    responder = () => ({ status: 200, payload: responseWith(JSON.stringify({ reply: "The Harbor Candle is $24.00.", needsReview: false })) });
    const out = await draftReply("task-test", ctx, "How much is the candle?", "pricing");
    expect(out.model).toBe("muse-wonder-1.0");
    expect(out.reply).toContain("$24.00");
    const { body } = calls[0];
    expect(body.prompt_cache_key).toBe("metaops-draft_reply");
    expect(body.prompt_cache_retention).toBe("24h");
    const input = body.input as Array<{ content: Array<{ text: string }> }>;
    const userText = input[1].content[0].text;
    // Static-prefix-first: the business facts block comes before the
    // per-conversation data, which is what makes the prefix cacheable.
    expect(userText.indexOf("Business facts:")).toBeLessThan(userText.indexOf("Customer message"));
    expect(userText).toContain("Harbor Candle");
  });

  it("audit: Wonder model and metaops-audit cache key (independent second pass preserved)", async () => {
    responder = () => ({ status: 200, payload: responseWith(JSON.stringify({ ok: true, violations: [], injectionDetected: false })) });
    const out = await auditDraft(null, { ctx, platform: "messenger", kind: "reply", draftText: "The Harbor Candle is $24.00.", inboundText: "price?", lastInboundAt: new Date().toISOString() });
    expect(out.ok).toBe(true);
    expect(out.auditorModel).toBe("muse-wonder-1.0");
    expect(calls[0].body.prompt_cache_key).toBe("metaops-audit");
    expect(calls[0].body.model).toBe("muse-wonder-1.0");
  });

  it("plan and draft_content carry their own cache keys", async () => {
    responder = () => ({ status: 200, payload: responseWith(JSON.stringify({ objective: "o", steps: [{ operation: "generate_report", requiresApproval: false, rationale: "r" }] })) });
    await planObjective("task-x", "Summarize today", ["messenger"]);
    expect(calls[0].body.prompt_cache_key).toBe("metaops-plan");
    responder = () => ({ status: 200, payload: responseWith(JSON.stringify({ caption: "Weekend picks at Harbor Goods" })) });
    const c = await draftContent("task-test", ctx, "facebook", "Weekend promo");
    expect(c.caption).toContain("Harbor Goods");
    expect(calls[1].body.prompt_cache_key).toBe("metaops-draft_content");
  });

  it("both /models verify and /responses requests carry explicit User-Agent and Accept headers", async () => {
    // Regression (2026-10-27): api.meta.ai returns an EMPTY model catalog
    // to requests with neither a User-Agent nor an Accept header — the
    // Railway deployment's fetch defaults produced exactly that, so the
    // live app saw zero models and /responses 404'd model_not_found while
    // the same key returned 9 models elsewhere. Every Meta API call must
    // send explicit identifying headers; never rely on runtime defaults.
    responder = (url) => url.endsWith("/models")
      ? { status: 200, payload: { data: [{ id: "muse-wonder-1.0" }, { id: "muse-spark-1.3" }] } }
      : { status: 200, payload: responseWith(JSON.stringify({ category: "pricing", leadPotential: "medium", explanation: "Asks price.", productInterest: "Harbor Candle" })) };
    const v = await verifyModelApi();
    expect(v.ok).toBe(true);
    await classifyMessage("task-test", "How much is the Harbor Candle?", ["Harbor Candle"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.meta.ai/v1/models");
    expect(calls[1].url).toBe("https://api.meta.ai/v1/responses");
    for (const c of calls) {
      expect(c.headers["User-Agent"]).toBeTruthy();
      expect(c.headers["User-Agent"]).toContain("FounderFloOps");
      expect(c.headers["Accept"]).toBe("application/json");
      expect(c.headers["Authorization"]).toMatch(/^Bearer /);
    }
  });

  it("non-2xx surfaces as meta_api_<status> with the provider error body (402 billing shape)", async () => {
    responder = () => ({ status: 402, payload: { error: { code: "billing_not_configured", message: "To use this API key, your team needs to resolve a billing issue first", param: null, type: "invalid_request_error" } } });
    await expect(classifyMessage("task-test", "hi", [])).rejects.toThrow(/meta_api_402/);
    await expect(classifyMessage("task-test", "hi", [])).rejects.toThrow(/billing_not_configured/);
  });

  it("output parsing skips reasoning items and extracts the message JSON", async () => {
    responder = () => ({ status: 200, payload: responseWith("prefix noise {\"reply\": \"grounded reply\", \"needsReview\": true} trailing") });
    const out = await draftReply("task-test", ctx, "question", "general");
    expect(out.reply).toBe("grounded reply");
    expect(out.needsReview).toBe(true);
  });
});

describe("planObjective corrective re-ask (planner resilience, 2026-10-26)", () => {
  const step = (operation: string, rationale: string) => ({ operation, requiresApproval: false, rationale });
  // 13 steps: one over the shared schema cap (steps min 1, max 12) — the
  // exact shape that killed three live hero-objective runs on 2026-10-26
  // with "invalid_model_plan: Array must contain at most 12 element(s)".
  const overCapPlan = JSON.stringify({
    objective: "hero",
    steps: Array.from({ length: 13 }, (_, i) => step("list_eligible_messages", `step-${i}`)),
  });
  const validPlan = JSON.stringify({
    objective: "hero",
    steps: [step("list_eligible_messages", "merged-inquiries"), step("generate_report", "report")],
  });

  it("first plan over the cap, corrected plan valid → succeeds with the corrected plan, exactly 2 calls", async () => {
    let n = 0;
    responder = () => { n += 1; return { status: 200, payload: responseWith(n === 1 ? overCapPlan : validPlan) }; };
    const { plan, model } = await planObjective("task-fix", "Handle today's customer inquiries", ["messenger"]);
    expect(model).toBe("muse-wonder-1.0");
    expect(calls).toHaveLength(2);
    // The plan actually used is the corrected one, not the rejected original.
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].rationale).toBe("merged-inquiries");
    // First call is the ordinary plan call; the follow-up is labelled as a
    // correction and carries the validation error back to the model.
    expect(calls[0].body.prompt_cache_key).toBe("metaops-plan");
    expect(calls[1].body.prompt_cache_key).toBe("metaops-plan_correction");
    const correctionInput = calls[1].body.input as Array<{ content: Array<{ text: string }> }>;
    expect(correctionInput[1].content[0].text).toContain("at most 12");
    // The system prompt itself now states the step limit up front.
    const firstInput = calls[0].body.input as Array<{ content: Array<{ text: string }> }>;
    expect(firstInput[0].content[0].text).toContain("AT MOST 12 steps");
  });

  it("two consecutive invalid plans → throws invalid_model_plan after exactly 2 model calls", async () => {
    responder = () => ({ status: 200, payload: responseWith(overCapPlan) });
    await expect(planObjective("task-fix2", "Handle today's customer inquiries", ["messenger"]))
      .rejects.toThrow(/invalid_model_plan: Array must contain at most 12 element\(s\)/);
    expect(calls).toHaveLength(2);
  });

  it("valid first plan → no correction call (exactly 1 model call)", async () => {
    responder = () => ({ status: 200, payload: responseWith(validPlan) });
    const { plan } = await planObjective("task-fix3", "Handle today's customer inquiries", ["messenger"]);
    expect(plan.steps).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});

describe("transient empty-catalog / model_not_found retry (2026-10-27)", () => {
  it("verify: empty catalog first, full catalog second → verified, exactly 2 calls", async () => {
    let n = 0;
    responder = () => { n += 1; return n === 1
      ? { status: 200, payload: { data: [] } }
      : { status: 200, payload: { data: [{ id: "muse-wonder-1.0" }, { id: "muse-spark-1.3" }] } }; };
    const v = await verifyModelApi();
    expect(v.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("verify: catalog always empty → primary_model_not_listed after exactly 4 attempts", async () => {
    responder = () => ({ status: 200, payload: { data: [] } });
    const v = await verifyModelApi();
    expect(v.ok).toBe(false);
    expect(v.status).toBe("primary_model_not_listed");
    expect(calls).toHaveLength(4);
  });

  it("responses: 404 model_not_found first, success second → succeeds, exactly 2 calls", async () => {
    let n = 0;
    responder = () => { n += 1; return n === 1
      ? { status: 404, payload: { error: { code: "model_not_found", message: "model not found" } } }
      : { status: 200, payload: responseWith(JSON.stringify({ category: "pricing", leadPotential: "medium", explanation: "Asks price.", productInterest: "Harbor Candle" })) }; };
    const { classification } = await classifyMessage("task-retry", "How much is the Harbor Candle?", ["Harbor Candle"]);
    expect(classification.category).toBe("pricing");
    expect(calls).toHaveLength(2);
  });

  it("responses: 402 billing still fails fast with exactly 1 call", async () => {
    responder = () => ({ status: 402, payload: { error: { code: "billing_not_configured", message: "billing" } } });
    await expect(classifyMessage("task-noretry", "hi", [])).rejects.toThrow(/meta_api_402/);
    expect(calls).toHaveLength(1);
  });
});

describe("approxCostUsd rate pins (AI_USAGE.md)", () => {
  it("matches the verified list prices", () => {
    expect(approxCostUsd("demo-heuristic-v1 (not Meta AI)", 1e6, 1e6)).toBe(0);
    expect(approxCostUsd("muse-wonder-1.0", 1e6, 1e6)).toBeCloseTo(4.0 + 20.0, 6);
    expect(approxCostUsd("muse-spark-1.3", 1e6, 1e6)).toBeCloseTo(1.25 + 4.25, 6);
  });
});
