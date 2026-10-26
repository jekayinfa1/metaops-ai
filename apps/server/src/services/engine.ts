import { randomUUID } from "node:crypto";
import { getDb, audit } from "../db/store.js";
import { adapterFor } from "../adapters/factory.js";
import type { ConnectionRow } from "../adapters/types.js";
import { planObjective, classifyMessage, draftReply, draftContent, auditDraft, correctDraft, activePlannerModel, type BusinessContext, type AuditInput } from "./ai.js";
import { payloadHash } from "./security.js";
import type { Plan, ReceiptAction } from "@metaops/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = new Set<string>();
const paused = new Set<string>();
const cancelled = new Set<string>();

interface BizRow { id: string; userId: string; name: string; description: string; hours: string; location: string; returnPolicy: string; tone: string; escalationContact: string; faqsJson: string }
interface ConvRow { id: string; businessId: string; connectionId: string; platform: string; externalThreadId: string; customerName: string; category: string | null; suggestedReply: string | null }
interface StepRow { id: string; taskId: string; seq: number; operation: string; platform: string | null; requiresApproval: number; status: string; attempts: number; idempotencyKey: string }

const d = () => getDb();
const now = () => new Date().toISOString();

export function businessContext(businessId: string): BusinessContext {
  const b = d().prepare("SELECT id, user_id as userId, name, description, hours, location, return_policy as returnPolicy, tone, escalation_contact as escalationContact, faqs_json as faqsJson FROM businesses WHERE id=?").get(businessId) as unknown as BizRow;
  const products = d().prepare("SELECT name, description, price_cents as priceCents, in_stock as inStock FROM products WHERE business_id=?").all(businessId) as unknown as Array<{ name: string; description: string; priceCents: number | null; inStock: number }>;
  return {
    name: b.name, description: b.description, hours: b.hours, location: b.location, returnPolicy: b.returnPolicy, tone: b.tone,
    faqs: JSON.parse(b.faqsJson), products: products.map((p) => ({ ...p, inStock: Boolean(p.inStock) }))
  };
}
function connectionsFor(businessId: string): ConnectionRow[] {
  return d().prepare("SELECT id, business_id as businessId, platform, mode, display_name as displayName, external_account_id as externalAccountId, token_encrypted as tokenEncrypted, token_expires_at as tokenExpiresAt, status, permissions_json as permissionsJson FROM connections WHERE business_id=? AND status='connected'").all(businessId) as unknown as ConnectionRow[];
}
function setTaskState(taskId: string, state: string, failureReason?: string) {
  d().prepare("UPDATE tasks SET state=?, failure_reason=? WHERE id=?").run(state, failureReason ?? null, taskId);
  audit("task:" + taskId, "state_" + state);
  emit(taskId);
}
function updateStep(stepId: string, patch: Partial<{ status: string; detail: string; outputJson: string; attempts: number }>) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const map: Record<string, string> = { status: "status", detail: "detail", outputJson: "output_json", attempts: "attempts" };
  d().prepare(`UPDATE task_steps SET ${cols.map((c) => `${map[c]}=?`).join(",")} WHERE id=?`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .run(...cols.map((c) => (patch as any)[c]), stepId);
}

// --- SSE listeners ---
const listeners = new Map<string, Set<(data: string) => void>>();
export function subscribeTask(taskId: string, fn: (data: string) => void) {
  if (!listeners.has(taskId)) listeners.set(taskId, new Set());
  listeners.get(taskId)!.add(fn);
  return () => listeners.get(taskId)?.delete(fn);
}
export function emit(taskId: string) {
  const task = d().prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const steps = d().prepare("SELECT * FROM task_steps WHERE task_id=? ORDER BY seq").all(taskId);
  const msg = JSON.stringify({ task, steps });
  for (const fn of listeners.get(taskId) ?? []) { try { fn(msg); } catch { /* closed */ } }
}

export function pauseTask(id: string) { paused.add(id); setTaskState(id, "paused"); }
export function resumeTask(id: string) { paused.delete(id); void runTask(id); }
export function cancelTask(id: string) {
  cancelled.add(id);
  d().prepare("UPDATE tasks SET state='cancelled', finished_at=? WHERE id=? AND state NOT IN ('completed','partially_completed','failed')").run(now(), id);
  emit(id);
}

export async function createTask(businessId: string, userId: string, objective: string) {
  const id = randomUUID();
  d().prepare("INSERT INTO tasks (id, business_id, user_id, objective, state, created_at) VALUES (?,?,?,?, 'created', ?)")
    .run(id, businessId, userId, objective, now());
  audit("user:" + userId, "task_created", id);
  void runTask(id);
  return id;
}

/**
 * The operations engine. Planning produces validated steps; execution is
 * checkpointed per step; external actions require payload-bound approvals;
 * every external action carries an idempotency key; uncertain outcomes are
 * reconciled against the platform adapter before any retry.
 */
export async function runTask(taskId: string) {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    const task = d().prepare("SELECT id, business_id as businessId, objective, state, plan_json as planJson FROM tasks WHERE id=?").get(taskId) as unknown as { id: string; businessId: string; objective: string; state: string; planJson: string | null } | undefined;
    if (!task) return;
    const conns = connectionsFor(task.businessId);
    if (!conns.length) { setTaskState(taskId, "awaiting_connection", "no_connected_accounts"); d().prepare("UPDATE tasks SET finished_at=? WHERE id=?").run(now(), taskId); return; }

    let steps = d().prepare("SELECT * FROM task_steps WHERE task_id=? ORDER BY seq").all(taskId) as unknown as StepRow[];
    if (!steps.length) {
      setTaskState(taskId, "planning");
      const caps: string[] = [];
      for (const c of conns) { const a = adapterFor(c); for (const cap of await a.capabilities()) if (cap.available) caps.push(`${c.platform}:${cap.key}`); }
      let plan: Plan; let model: string;
      try { ({ plan, model } = await planObjective(taskId, task.objective, caps)); }
      catch (e) { setTaskState(taskId, "failed", "planning_failed: " + (e as Error).message); d().prepare("UPDATE tasks SET finished_at=? WHERE id=?").run(now(), taskId); return; }
      d().prepare("UPDATE tasks SET plan_json=?, models_json=? WHERE id=?").run(JSON.stringify(plan), JSON.stringify([model]), taskId);
      plan.steps.forEach((s, i) => {
        d().prepare("INSERT INTO task_steps (id, task_id, seq, operation, platform, requires_approval, status, idempotency_key) VALUES (?,?,?,?,?,?, 'pending', ?)")
          .run(randomUUID(), taskId, i, s.operation, s.platform ?? null, s.requiresApproval ? 1 : 0, `${taskId}:${i}:${s.operation}`);
      });
      steps = d().prepare("SELECT * FROM task_steps WHERE task_id=? ORDER BY seq").all(taskId) as unknown as StepRow[];
    }

    setTaskState(taskId, "running");
    let anyFailed = false; let anyCompleted = false;

    for (const step of steps) {
      if (cancelled.has(taskId)) { setTaskState(taskId, "cancelled"); return; }
      while (paused.has(taskId)) { await sleep(500); if (cancelled.has(taskId)) { setTaskState(taskId, "cancelled"); return; } }
      if (step.status === "completed" || step.status === "skipped") { anyCompleted ||= step.status === "completed"; continue; }
      updateStep(step.id, { status: "running" });
      emit(taskId);
      try {
        const result = await withRetry(taskId, step, () => executeStep(taskId, task.businessId, step));
        if (result === "awaiting_approval") {
          setTaskState(taskId, "awaiting_approval");
          // Park until approvals are decided; the approvals API resumes us.
          while (true) {
            await sleep(700);
            if (cancelled.has(taskId)) { setTaskState(taskId, "cancelled"); return; }
            const pending = d().prepare("SELECT COUNT(*) as n FROM approvals WHERE task_id=? AND status='pending'").get(taskId) as unknown as { n: number };
            if (pending.n === 0) break;
          }
          setTaskState(taskId, "running");
          // Re-run the step: approved items execute, rejected are skipped.
          const result2 = await executeStep(taskId, task.businessId, step);
          if (result2 === "awaiting_approval") throw new Error("approval_still_pending");
          updateStep(step.id, { status: "completed", detail: "executed after approval" });
          anyCompleted = true;
        } else {
          updateStep(step.id, { status: "completed" });
          anyCompleted = true;
        }
      } catch (e) {
        anyFailed = true;
        updateStep(step.id, { status: "failed", detail: (e as Error).message.slice(0, 400) });
        audit("task:" + taskId, "step_failed", `${step.operation}: ${(e as Error).message}`);
      }
      emit(taskId);
    }

    const finalState = anyFailed ? (anyCompleted ? "partially_completed" : "failed") : "completed";
    d().prepare("UPDATE tasks SET finished_at=? WHERE id=?").run(now(), taskId);
    setTaskState(taskId, finalState);
  } finally {
    running.delete(taskId);
    cancelled.delete(taskId);
  }
}

async function withRetry(taskId: string, step: StepRow, fn: () => Promise<string>): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) { updateStep(step.id, { attempts: attempt }); setTaskState(taskId, "recovering"); await sleep(300 * attempt); setTaskState(taskId, "running"); }
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      // Only transient-looking failures retry; validation/permission errors fail fast.
      if (!/(timeout|network|fetch|429|5\d\d|rate)/i.test(lastErr.message)) throw lastErr;
    }
  }
  throw lastErr ?? new Error("step_failed");
}

function pendingApproval(taskId: string, businessId: string, kind: string, platform: string, summary: string, payload: unknown): string {
  const existing = d().prepare("SELECT id FROM approvals WHERE task_id=? AND payload_hash=? AND status='pending'").get(taskId, payloadHash(payload)) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  d().prepare("INSERT INTO approvals (id, business_id, task_id, kind, platform, summary, payload_json, payload_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)")
    .run(id, businessId, taskId, kind, platform, summary, JSON.stringify(payload), payloadHash(payload), now());
  return id;
}

function recordAudit(taskId: string, entityType: string, entityRef: string, attempt: number, ok: boolean, violations: unknown, injectionDetected: boolean, auditorModel: string) {
  d().prepare("INSERT INTO draft_audits (id, task_id, entity_type, entity_ref, attempt, ok, violations_json, injection_detected, auditor_model, at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), taskId, entityType, entityRef, attempt, ok ? 1 : 0, JSON.stringify(violations), injectionDetected ? 1 : 0, auditorModel, now());
}

/**
 * Dual-pass gate: Pass 1 drafts, Pass 2 (independent auditor) verifies.
 * A blocked draft loops back for one self-correction; if the correction
 * still fails, the draft fails CLOSED (never reaches approvals).
 */
async function auditLoop(taskId: string, input: AuditInput, actions: ReceiptAction[], target: string): Promise<{ text: string; templateRequired: boolean } | null> {
  const first = await auditDraft(taskId, input);
  recordAudit(taskId, input.kind, target, 1, first.ok, first.violations, first.injectionDetected, first.auditorModel);
  if (first.ok) {
    actions.push({ operation: "audit_draft", platform: input.platform, target, status: "confirmed", detail: `Auditor pass (${first.auditorModel}).${first.injectionDetected ? " Injection attempt detected in the customer message; draft does not comply with it." : ""}` });
    return { text: input.draftText, templateRequired: false };
  }
  actions.push({ operation: "audit_draft", platform: input.platform, target, status: "blocked", detail: `Auditor BLOCKED draft: ${first.violations.map((v) => `${v.type} - ${v.detail}`).join("; ")}` });
  const corrected = correctDraft(input, first.violations);
  // A template message is the compliant way to reach an out-of-window customer,
  // so the re-audit evaluates the corrected text as a template (window rule N/A).
  const second = await auditDraft(taskId, { ...input, draftText: corrected.text, lastInboundAt: corrected.templateRequired ? null : input.lastInboundAt });
  recordAudit(taskId, input.kind, target, 2, second.ok, second.violations, second.injectionDetected, second.auditorModel);
  if (second.ok) {
    actions.push({ operation: "audit_draft", platform: input.platform, target, status: "confirmed", detail: `Self-corrected draft passed re-audit (${second.auditorModel}).${corrected.templateRequired ? " Converted to a template message because the conversation is outside the 24h window." : ""}` });
    return { text: corrected.text, templateRequired: corrected.templateRequired };
  }
  actions.push({ operation: "audit_draft", platform: input.platform, target, status: "failed", detail: `Draft failed audit twice and was withheld from approvals (fail-closed): ${second.violations.map((v) => v.type).join(", ")}` });
  return null;
}

// ---------------- Step executors ----------------

async function executeStep(taskId: string, businessId: string, step: StepRow): Promise<"done" | "awaiting_approval"> {
  const conns = connectionsFor(businessId);
  const ctx = businessContext(businessId);
  const actions: ReceiptAction[] = [];
  const finish = (status: "done" | "awaiting_approval") => {
    updateStep(step.id, { outputJson: JSON.stringify({ actions }) });
    return status;
  };

  switch (step.operation) {
    case "list_eligible_messages": {
      let count = 0;
      let connFailures = 0;
      for (const conn of conns) {
        const adapter = adapterFor(conn);
        let convs;
        try { convs = await adapter.listConversations(); }
        catch (e) {
          // A broken/expired connection must not kill operations for healthy ones.
          connFailures++;
          actions.push({ operation: step.operation, platform: conn.platform, target: conn.displayName, status: "failed", detail: "Sync failed for this connection: " + (e as Error).message });
          continue;
        }
        for (const c of convs) {
          const existing = d().prepare("SELECT id FROM conversations WHERE connection_id=? AND external_thread_id=?").get(conn.id, c.externalThreadId) as { id: string } | undefined;
          const convId = existing?.id ?? randomUUID();
          if (!existing) {
            d().prepare("INSERT INTO conversations (id, business_id, connection_id, platform, external_thread_id, customer_name, customer_ref, last_message_at) VALUES (?,?,?,?,?,?,?,?)")
              .run(convId, businessId, conn.id, conn.platform, c.externalThreadId, c.customerName, c.customerRef, c.messages.at(-1)?.at ?? now());
          }
          for (const m of c.messages) {
            d().prepare("INSERT OR IGNORE INTO messages (id, conversation_id, direction, body, at, status, external_id) VALUES (?,?,?,?,?,?,?)")
              .run(randomUUID(), convId, m.direction, m.body, m.at, "received", m.externalId);
          }
          count++;
        }
        actions.push({ operation: step.operation, platform: conn.platform, target: conn.displayName, status: "confirmed", detail: `${convs.length} conversation(s) synced from ${conn.mode} connection` });
      }
      if (count === 0 && connFailures > 0) {
        const firstFailure = actions.find((a) => a.status === "failed")?.detail ?? "unknown";
        throw new Error("all_connections_failed_sync: " + firstFailure);
      }
      updateStep(step.id, { detail: `${count} conversations synced${connFailures ? `, ${connFailures} connection(s) failed` : ""}` });
      return finish("done");
    }

    case "classify_conversations": {
      const convs = d().prepare("SELECT id, business_id as businessId, connection_id as connectionId, platform, external_thread_id as externalThreadId, customer_name as customerName, category, product_interest as productInterest, suggested_reply as suggestedReply FROM conversations WHERE business_id=? AND category IS NULL").all(businessId) as unknown as ConvRow[];
      const productNames = ctx.products.map((p) => p.name);
      for (const conv of convs) {
        const lastIn = d().prepare("SELECT body FROM messages WHERE conversation_id=? AND direction='in' ORDER BY at DESC LIMIT 1").get(conv.id) as { body: string } | undefined;
        if (!lastIn) continue;
        const { classification } = await classifyMessage(taskId, lastIn.body, productNames);
        d().prepare("UPDATE conversations SET category=?, product_interest=?, classification_json=?, lead_status=?, workflow_state='classified' WHERE id=?")
          .run(classification.category, classification.productInterest, JSON.stringify(classification),
            classification.leadPotential === "high" || classification.leadPotential === "medium" ? "potential_lead" : "new", conv.id);
        actions.push({ operation: step.operation, platform: conv.platform, target: conv.customerName, status: "confirmed", detail: `${classification.category} (${classification.leadPotential}): ${classification.explanation}` });
      }
      updateStep(step.id, { detail: `${actions.length} conversations classified` });
      return finish("done");
    }

    case "draft_replies": {
      const convs = d().prepare("SELECT id, business_id as businessId, connection_id as connectionId, platform, external_thread_id as externalThreadId, customer_name as customerName, category, product_interest as productInterest, suggested_reply as suggestedReply FROM conversations WHERE business_id=? AND category IS NOT NULL AND suggested_reply IS NULL").all(businessId) as unknown as ConvRow[];
      let drafted = 0; let withheld = 0;
      for (const conv of convs) {
        const lastIn = d().prepare("SELECT body, at FROM messages WHERE conversation_id=? AND direction='in' ORDER BY at DESC LIMIT 1").get(conv.id) as { body: string; at: string } | undefined;
        if (!lastIn) continue;
        const { reply, needsReview } = await draftReply(taskId, ctx, lastIn.body, conv.category ?? "general");
        const audited = await auditLoop(taskId, { ctx, platform: conv.platform, kind: "reply", draftText: reply, inboundText: lastIn.body, lastInboundAt: lastIn.at }, actions, conv.customerName);
        if (!audited) { withheld++; d().prepare("UPDATE conversations SET workflow_state='audit_blocked' WHERE id=?").run(conv.id); continue; }
        d().prepare("UPDATE conversations SET suggested_reply=?, template_required=?, workflow_state='drafted' WHERE id=?").run(audited.text, audited.templateRequired ? 1 : 0, conv.id);
        drafted++;
        actions.push({ operation: step.operation, platform: conv.platform, target: conv.customerName, status: "confirmed", detail: needsReview ? "Draft prepared and auditor-verified; flagged for human review (missing facts)." : "Draft prepared from business knowledge base and auditor-verified." });
      }
      updateStep(step.id, { detail: `${drafted} replies drafted and audited${withheld ? `, ${withheld} withheld by auditor` : ""}` });
      return finish("done");
    }

    case "send_approved_replies": {
      const convs = d().prepare("SELECT id, business_id as businessId, connection_id as connectionId, platform, external_thread_id as externalThreadId, customer_name as customerName, category, product_interest as productInterest, suggested_reply as suggestedReply, template_required as templateRequired FROM conversations WHERE business_id=? AND suggested_reply IS NOT NULL AND workflow_state IN ('drafted','awaiting_approval')").all(businessId) as unknown as ConvRow[];
      let needsApproval = false;
      for (const conv of convs) {
        const payload = { conversationId: conv.id, platform: conv.platform, to: conv.customerName, body: conv.suggestedReply, template: Boolean((conv as unknown as { templateRequired: number }).templateRequired) };
        const approval = d().prepare("SELECT * FROM approvals WHERE task_id=? AND payload_hash=?").get(taskId, payloadHash(payload)) as unknown as { id: string; status: string } | undefined;
        if (!approval) {
          pendingApproval(taskId, businessId, "send_message", conv.platform, `Send reply to ${conv.customerName} on ${conv.platform}`, payload);
          d().prepare("UPDATE conversations SET workflow_state='awaiting_approval' WHERE id=?").run(conv.id);
          needsApproval = true;
          actions.push({ operation: step.operation, platform: conv.platform, target: conv.customerName, status: "pending_approval", detail: "Reply awaiting owner approval." });
          continue;
        }
        if (approval.status === "pending") { needsApproval = true; continue; }
        if (approval.status === "rejected" || approval.status === "invalidated") {
          d().prepare("UPDATE conversations SET workflow_state='approval_rejected' WHERE id=?").run(conv.id);
          actions.push({ operation: step.operation, platform: conv.platform, target: conv.customerName, status: "skipped", detail: `Approval ${approval.status}; message not sent.` });
          continue;
        }
        // approved: send with idempotency; verify by read-back before claiming confirmation.
        const conn = conns.find((c) => c.id === (d().prepare("SELECT connection_id as cid FROM conversations WHERE id=?").get(conv.id) as { cid: string }).cid);
        if (!conn) throw new Error("connection_missing_for_conversation");
        const adapter = adapterFor(conn);
        const idem = `${taskId}:send:${conv.id}`;
        const sent = await adapter.sendMessage(conv.externalThreadId, conv.suggestedReply!, idem);
        d().prepare("INSERT OR IGNORE INTO messages (id, conversation_id, direction, body, at, status, external_id, idempotency_key) VALUES (?,?, 'out', ?, ?, 'sent', ?, ?)")
          .run(randomUUID(), conv.id, conv.suggestedReply, now(), sent.externalId, idem);
        setTaskState(taskId, "verifying");
        const check = await adapter.getObject(sent.externalId);
        d().prepare("UPDATE conversations SET workflow_state=?, lead_status=CASE WHEN lead_status='potential_lead' THEN 'contacted' ELSE lead_status END WHERE id=?")
          .run(check.exists ? "sent_confirmed" : "sent_unverified", conv.id);
        actions.push({ operation: step.operation, platform: conv.platform, target: conv.customerName, status: check.exists ? "confirmed" : "accepted_unconfirmed", detail: check.exists ? `Platform read-back confirmed message ${sent.externalId}.` : `Platform accepted message ${sent.externalId} but read-back did not confirm it.`, externalId: sent.externalId });
        setTaskState(taskId, "running");
      }
      updateStep(step.id, { detail: `${actions.length} repl${actions.length === 1 ? "y" : "ies"} processed` });
      return finish(needsApproval ? "awaiting_approval" : "done");
    }

    case "identify_leads": {
      const convs = d().prepare("SELECT id, business_id as businessId, connection_id as connectionId, platform, external_thread_id as externalThreadId, customer_name as customerName, category, product_interest as productInterest, suggested_reply as suggestedReply FROM conversations WHERE business_id=? AND lead_status IN ('potential_lead','new','contacted') AND category IN ('sales_interest','pricing','availability')").all(businessId) as unknown as ConvRow[];
      let created = 0;
      for (const conv of convs) {
        const cls = d().prepare("SELECT classification_json as cj FROM conversations WHERE id=?").get(conv.id) as { cj: string | null };
        const parsed = cls.cj ? JSON.parse(cls.cj) as { leadPotential: string; explanation: string; productInterest: string | null } : null;
        d().prepare("INSERT OR IGNORE INTO leads (id, business_id, conversation_id, platform, customer_name, category, product_interest, priority, explanation, status, follow_up_eligible, last_contact_at, created_at) VALUES (?,?,?,?,?,?,?,?,?, 'new', ?, ?, ?)")
          .run(randomUUID(), businessId, conv.id, conv.platform, conv.customerName, conv.category ?? "general",
            (conv as unknown as { productInterest: string | null }).productInterest ?? parsed?.productInterest ?? null,
            parsed?.leadPotential === "high" ? "high" : parsed?.leadPotential === "medium" ? "medium" : "low",
            (parsed?.explanation ?? "Identified from inquiry category.") + " (AI suggestion — not verified purchase intent.)",
            1, now(), now());
        created++;
      }
      updateStep(step.id, { detail: `${created} lead record(s) created or already present` });
      actions.push({ operation: step.operation, target: "leads", status: "confirmed", detail: `${created} lead(s) recorded from buying-interest inquiries.` });
      return finish("done");
    }

    case "create_content_drafts": {
      const task = d().prepare("SELECT objective FROM tasks WHERE id=?").get(taskId) as unknown as { objective: string };
      for (const platform of ["facebook", "instagram"] as const) {
        const conn = conns.find((c) => c.platform === platform);
        const { caption } = await draftContent(taskId, ctx, platform, task.objective);
        const audited = await auditLoop(taskId, { ctx, platform, kind: "content", draftText: caption }, actions, platform);
        if (!audited) { actions.push({ operation: step.operation, platform, target: platform, status: "failed", detail: "Content draft withheld by auditor (fail-closed)." }); continue; }
        const idem = `${taskId}:content:${platform}`;
        d().prepare("INSERT OR IGNORE INTO content_items (id, business_id, connection_id, platform, kind, caption, status, created_at, idempotency_key) VALUES (?,?,?,?, 'post', ?, 'draft', ?, ?)")
          .run(randomUUID(), businessId, conn?.id ?? null, platform, audited.text, now(), idem);
        actions.push({ operation: step.operation, platform, target: platform, status: "confirmed", detail: "Content draft created from catalog facts and auditor-verified." });
      }
      updateStep(step.id, { detail: "Content drafts created" });
      return finish("done");
    }

    case "publish_approved_content": {
      const items = d().prepare("SELECT * FROM content_items WHERE business_id=? AND status IN ('draft','awaiting_approval') AND idempotency_key LIKE ?").all(businessId, `${taskId}:content:%`) as unknown as Array<{ id: string; platform: string; caption: string; connectionId: string | null; status: string }>;
      let needsApproval = false;
      for (const item of items) {
        const payload = { contentId: item.id, platform: item.platform, caption: item.caption };
        const approval = d().prepare("SELECT * FROM approvals WHERE task_id=? AND payload_hash=?").get(taskId, payloadHash(payload)) as unknown as { status: string } | undefined;
        if (!approval) {
          pendingApproval(taskId, businessId, "publish_post", item.platform, `Publish ${item.platform} post`, payload);
          d().prepare("UPDATE content_items SET status='awaiting_approval' WHERE id=?").run(item.id);
          needsApproval = true;
          actions.push({ operation: step.operation, platform: item.platform, target: item.platform, status: "pending_approval", detail: "Post awaiting owner approval." });
          continue;
        }
        if (approval.status === "pending") { needsApproval = true; continue; }
        if (approval.status !== "approved") {
          d().prepare("UPDATE content_items SET status='draft' WHERE id=?").run(item.id);
          actions.push({ operation: step.operation, platform: item.platform, target: item.platform, status: "skipped", detail: `Approval ${approval.status}; not published.` });
          continue;
        }
        const conn = conns.find((c) => c.id === item.connectionId) ?? conns.find((c) => c.platform === item.platform);
        if (!conn) { actions.push({ operation: step.operation, platform: item.platform, target: item.platform, status: "blocked", detail: "No connected account for this platform." }); continue; }
        const adapter = adapterFor(conn);
        try {
          const published = await adapter.publishPost(item.caption, `${taskId}:publish:${item.id}`);
          setTaskState(taskId, "verifying");
          const check = await adapter.getObject(published.externalId);
          d().prepare("UPDATE content_items SET status=?, external_id=? WHERE id=?").run(check.exists ? "published" : "unverified", published.externalId, item.id);
          actions.push({ operation: step.operation, platform: item.platform, target: item.platform, status: check.exists ? "confirmed" : "accepted_unconfirmed", detail: check.exists ? `Published and read-back confirmed (${published.externalId}).` : `Accepted (${published.externalId}) but not confirmed by read-back.`, externalId: published.externalId });
          setTaskState(taskId, "running");
        } catch (e) {
          d().prepare("UPDATE content_items SET status='failed' WHERE id=?").run(item.id);
          actions.push({ operation: step.operation, platform: item.platform, target: item.platform, status: "failed", detail: (e as Error).message });
        }
      }
      updateStep(step.id, { detail: `${items.length} content item(s) processed` });
      return finish(needsApproval ? "awaiting_approval" : "done");
    }

    case "generate_report": {
      updateStep(step.id, { detail: "Activity receipt generated from persisted task evidence" });
      actions.push({ operation: step.operation, target: "receipt", status: "confirmed", detail: "Receipt available at GET /api/tasks/:id/receipt, built from API results and read-back verification — not from model claims." });
      return finish("done");
    }

    default:
      throw new Error("operation_not_allowlisted: " + step.operation);
  }
}
