import { sha256hex, canonicalJson } from "./security.js";
import type { ActivityReceipt, ReceiptAction, TaskState, VerificationAssessment, VerificationLevel } from "@metaops/shared";
import { getDb } from "../db/store.js";
import { approxCostUsd } from "./ai.js";

/**
 * ---------------------------------------------------------------------------
 * Verification taxonomy and receipt integrity — read this before changing
 * any "confirmed"/"verified" wording anywhere in the product.
 *
 * A receipt action's status says what the workflow did. Its `verification`
 * says what evidence proves it, using the levels in @metaops/shared. The
 * classifier below is the ONLY place external-action levels are assigned,
 * and it is deliberately conservative: a level is never upgraded beyond the
 * evidence supplied, and sandbox evidence never becomes live evidence.
 *
 * Strongest strategy each platform/action actually supports today:
 * - Facebook Page publish: POST /{page}/feed returns the post id; a later
 *   GET /{post-id} read-back proves the post object exists on the platform
 *   -> "published" (basis platform_readback).
 * - Instagram publish: media_publish returns the media id; GET /{media-id}
 *   read-back proves the published media object -> "published".
 * - Messenger / Instagram message send: the Send API returns a message id;
 *   GET /{message-id} read-back proves the message object exists ->
 *   "object_confirmed". It does NOT prove the customer saw it.
 * - WhatsApp send: the Cloud API returns a wamid. There is no general
 *   message read-back endpoint, so without webhook evidence the ceiling is
 *   "provider_id_returned". Delivery/read are only claimable from WhatsApp
 *   webhook status receipts (basis webhook_receipt).
 *
 * Known evidence gaps (honest ceilings, not bugs in this file):
 * - Webhook delivery/read receipts are received by the webhook route but
 *   are not persisted against outbound messages, so no code path currently
 *   supplies `deliveryEvidence` and no action can earn "delivered"/"read".
 * - "objective_verified" is defined for completeness and is NEVER emitted
 *   from adapter evidence: it would require confirmation independent of the
 *   provider's own API surface (e.g. the recipient's client), which Meta
 *   does not expose to us.
 * - Sandbox actions run the identical classification with mode "sandbox"
 *   and basis "sandbox_state": same ladder, clearly not live evidence.
 *
 * Receipt integrity: the SHA-256 below is a checksum over the canonical
 * receipt contents. It detects modification RELATIVE TO A TRUSTED REFERENCE
 * value of the hash. It is not a digital signature: it does not prove who
 * authored the receipt, and anyone holding altered contents can recompute a
 * matching checksum, so the hash only helps a verifier who obtained the
 * reference hash through a trusted channel. There is currently no managed
 * signing-key facility in this codebase to sign receipts with; adding one
 * is a documented gap (see SECURITY.md), not something to fake here.
 * ---------------------------------------------------------------------------
 */

/** Relative strength of levels (same-tier levels share a rank). */
export const VERIFICATION_LEVEL_RANK: Record<VerificationLevel, number> = {
  unverified: 0,
  request_attempted: 1,
  provider_accepted: 2,
  provider_id_returned: 3,
  object_confirmed: 4,
  published: 4,
  delivered: 5,
  read: 6,
  objective_verified: 7
};

export interface ExternalVerificationInput {
  /** send_message / send_template (a message to a customer) or publish_post. */
  kind: "send_message" | "send_template" | "publish_post";
  platform: string;
  mode: "live" | "sandbox";
  /** not_attempted: blocked before any provider call. attempted_unknown: a
   *  call was made but its outcome was never recorded (ambiguous — the
   *  request may have landed). accepted: the provider responded. */
  phase: "not_attempted" | "attempted_unknown" | "accepted";
  externalId?: string | null;
  /** Result of the post-send read-back, when one was performed. */
  readBack?: { exists: boolean; detail: string } | null;
  /** Delivery/read evidence from provider webhooks, when persisted. No
   *  current ingestion path supplies this; see the header comment. */
  deliveryEvidence?: "delivered" | "read" | null;
  /** Why an attempt did not happen or its outcome is unknown. */
  note?: string;
}

export function classifyExternalVerification(input: ExternalVerificationInput): VerificationAssessment {
  const { kind, mode } = input;
  const responseBasis = mode === "sandbox" ? "sandbox_state" : "provider_response";
  if (input.phase === "not_attempted") {
    return {
      level: "unverified", basis: "none", mode,
      evidence: "No provider attempt was made, so there is no outcome to verify.",
      reason: input.note ?? "The action was blocked before any provider attempt."
    };
  }
  if (input.phase === "attempted_unknown") {
    return {
      level: "unverified", basis: responseBasis, mode,
      evidence: "A provider attempt was made but its outcome was never recorded; the request may or may not have landed.",
      reason: input.note ?? "Attempt outcome unknown; not resent, pending reconciliation against the platform."
    };
  }
  // phase === "accepted": the provider responded to the request.
  if (!input.externalId) {
    return {
      level: "provider_accepted", basis: responseBasis, mode,
      evidence: mode === "sandbox"
        ? "The sandbox adapter accepted the request but returned no object identifier."
        : "The provider accepted the request but returned no object identifier, so nothing can be read back."
    };
  }
  let level: VerificationLevel = "provider_id_returned";
  let basis: VerificationAssessment["basis"] = responseBasis;
  let evidence = mode === "sandbox"
    ? `The sandbox adapter accepted the request and returned identifier ${input.externalId}.`
    : `The provider accepted the request and returned identifier ${input.externalId}.`;
  // Webhook delivery/read receipts are stronger than a bare acceptance and
  // are the only legitimate route to delivered/read. Sandbox has no webhooks.
  if (mode === "live" && input.deliveryEvidence) {
    level = input.deliveryEvidence;
    basis = "webhook_receipt";
    evidence += ` A provider webhook receipt evidences the message was ${input.deliveryEvidence === "read" ? "read by the recipient" : "delivered"}.`;
    return { level, basis, mode, evidence };
  }
  if (input.readBack) {
    if (input.readBack.exists) {
      level = kind === "publish_post" ? "published" : "object_confirmed";
      basis = mode === "sandbox" ? "sandbox_state" : "platform_readback";
      evidence = mode === "sandbox"
        ? `Sandbox read-back found the object (${input.externalId}) in sandbox state: ${input.readBack.detail}`
        : `Platform read-back fetched object ${input.externalId} and it exists: ${input.readBack.detail}`;
    } else {
      evidence += ` A read-back was attempted but did not confirm the object: ${input.readBack.detail} The level stays at provider_id_returned.`;
    }
  } else {
    evidence += " No read-back was performed, so existence on the platform is not independently confirmed.";
  }
  return { level, basis, mode, evidence };
}

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
  return { ...core, integrity: { algorithm: "sha256", receiptHash: sha256hex(canonicalJson(core)), note: "SHA-256 checksum over the receipt contents. It detects modification of the receipt relative to a trusted reference value of this hash. It is not a digital signature and does not prove who authored the receipt: anyone holding altered contents can recompute a matching checksum, so the hash only helps if the reference value was obtained from a trusted source. Receipts are not cryptographically signed (no managed signing key exists yet)." } };
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
