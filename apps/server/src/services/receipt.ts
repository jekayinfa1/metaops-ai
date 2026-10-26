import { sha256hex, canonicalJson } from "./security.js";
import type { ActivityReceipt, ReceiptAction, TaskState } from "@metaops/shared";
import { getDb } from "../db/store.js";
import { approxCostUsd } from "./ai.js";

export function buildReceipt(taskId: string): ActivityReceipt | null {
  const d = getDb();
  const task = d.prepare("SELECT id, business_id as businessId, objective, state, created_at as createdAt, finished_at as finishedAt, models_json as modelsJson FROM tasks WHERE id=?").get(taskId) as unknown as {
    id: string; businessId: string; objective: string; state: string; createdAt: string; finishedAt: string | null; modelsJson: string;
  } | undefined;
  if (!task) return null;
  const steps = d.prepare("SELECT operation, platform, status, detail, attempts, output_json as outputJson FROM task_steps WHERE task_id=? ORDER BY seq").all(taskId) as unknown as Array<{
    operation: string; platform: string | null; status: string; detail: string; outputJson: string | null;
  }>;
  const actions: ReceiptAction[] = [];
  for (const s of steps) {
    let out: { actions?: ReceiptAction[] } = {};
    try { out = s.outputJson ? JSON.parse(s.outputJson) : {}; } catch { out = {}; }
    if (out.actions?.length) actions.push(...out.actions);
    else actions.push({ operation: s.operation, platform: s.platform ?? undefined, target: "", status: s.status === "completed" ? "confirmed" : s.status === "failed" ? "failed" : s.status === "skipped" ? "skipped" : "unverified", detail: s.detail });
  }
  const approvals = (d.prepare("SELECT kind, decided_at, status, payload_hash FROM approvals WHERE task_id=?").all(taskId) as unknown as Array<{ kind: string; decided_at: string | null; status: string; payload_hash: string }>)
    .map((a) => ({ kind: a.kind, at: a.decided_at ?? "", decision: a.status, payloadHash: a.payload_hash }));
  const recoveries = steps.filter((s) => (s as unknown as { attempts: number }).attempts > 1)
    .map((s) => ({ step: s.operation, attempt: (s as unknown as { attempts: number }).attempts, reason: s.detail, at: "" }));
  const calls = d.prepare("SELECT model, input_tokens as inputTokens, output_tokens as outputTokens FROM ai_calls WHERE task_id=?").all(taskId) as unknown as Array<{ model: string; inputTokens: number; outputTokens: number }>;
  const usage = {
    aiCalls: calls.length,
    inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
    outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
    approxCostUsd: Number(calls.reduce((a, c) => a + approxCostUsd(c.model, c.inputTokens, c.outputTokens), 0).toFixed(4))
  };
  const core = {
    taskId: task.id, businessId: task.businessId, objective: task.objective,
    startedAt: task.createdAt, finishedAt: task.finishedAt, finalStatus: task.state as TaskState,
    actions, approvals, recoveries,
    modelsUsed: JSON.parse(task.modelsJson) as string[], usage
  };
  return { ...core, integrity: { algorithm: "sha256", receiptHash: sha256hex(canonicalJson(core)), note: "SHA-256 evidence checksum over the receipt contents (a checksum, not a digital signature)." } };
}

export function verifyReceiptIntegrity(r: ActivityReceipt): boolean {
  const { integrity, ...rest } = r;
  const core = {
    taskId: rest.taskId, businessId: rest.businessId, objective: rest.objective, startedAt: rest.startedAt,
    finishedAt: rest.finishedAt, finalStatus: rest.finalStatus, actions: rest.actions, approvals: rest.approvals,
    recoveries: rest.recoveries, modelsUsed: rest.modelsUsed, usage: rest.usage
  };
  return sha256hex(canonicalJson(core)) === integrity.receiptHash;
}
