import { z } from "zod";

export const Platform = z.enum(["facebook", "instagram", "messenger", "whatsapp"]);
export type Platform = z.infer<typeof Platform>;

export const InquiryCategory = z.enum([
  "product_question", "pricing", "availability", "order_support",
  "complaint", "booking", "sales_interest", "general"
]);
export type InquiryCategory = z.infer<typeof InquiryCategory>;

/** The complete allowlist of operations the AI planner may propose. Anything else is rejected. */
export const Operation = z.enum([
  "list_eligible_messages",
  "classify_conversations",
  "draft_replies",
  "send_approved_replies",
  "identify_leads",
  "create_content_drafts",
  "publish_approved_content",
  "generate_report"
]);
export type Operation = z.infer<typeof Operation>;

/** Operations whose execution changes external state and therefore always need human approval first. */
export const APPROVAL_OPERATIONS: ReadonlySet<string> = new Set(["send_approved_replies", "publish_approved_content"]);

export const PlanStep = z.object({
  operation: Operation,
  platform: Platform.optional(),
  requiresApproval: z.boolean(),
  rationale: z.string().max(500).default("")
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  objective: z.string().min(1).max(2000),
  steps: z.array(PlanStep).min(1).max(12)
});
export type Plan = z.infer<typeof Plan>;

export const Classification = z.object({
  category: InquiryCategory,
  leadPotential: z.enum(["none", "low", "medium", "high"]),
  explanation: z.string().max(400),
  productInterest: z.string().max(120).nullable().default(null)
});
export type Classification = z.infer<typeof Classification>;

export const TaskState = z.enum([
  "created", "planning", "awaiting_connection", "awaiting_permission", "awaiting_approval",
  "running", "verifying", "recovering", "paused",
  "completed", "partially_completed", "failed", "cancelled"
]);
export type TaskState = z.infer<typeof TaskState>;

/** Validate a raw model-produced plan. Model output is a proposal, never authorization. */
export function validatePlan(raw: unknown): { ok: boolean; plan?: Plan; reason?: string } {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid plan" };
  // Approval flags are enforced server-side: an external operation can never be marked approval-free.
  for (const step of parsed.data.steps) {
    if (APPROVAL_OPERATIONS.has(step.operation)) step.requiresApproval = true;
  }
  return { ok: true, plan: parsed.data };
}

export interface ReceiptAction {
  operation: string; platform?: string; target: string;
  status: "confirmed" | "accepted_unconfirmed" | "pending_approval" | "blocked" | "failed" | "unverified" | "skipped";
  detail: string; externalId?: string;
}
export interface ActivityReceipt {
  taskId: string; businessId: string; objective: string;
  startedAt: string; finishedAt: string | null; finalStatus: TaskState;
  actions: ReceiptAction[];
  approvals: Array<{ kind: string; at: string; decision: string; payloadHash: string }>;
  recoveries: Array<{ step: string; attempt: number; reason: string; at: string }>;
  modelsUsed: string[];
  usage: { aiCalls: number; inputTokens: number; outputTokens: number; approxCostUsd: number };
  integrity: { algorithm: "sha256"; receiptHash: string; note: string };
}
