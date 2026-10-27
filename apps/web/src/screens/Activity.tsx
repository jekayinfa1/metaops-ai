import { useCallback, useEffect, useState } from "react";
import { api, downloadJson, fmtTime, type Business, type Task } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, EmptyState, btnPrimary, btnSecondary } from "../components/ui";

/**
 * The receipt payload carries a structured verification assessment per
 * external action (assigned server-side by the taxonomy classifier in
 * services/receipt.ts). These local view types mirror it; lib/api.ts keeps
 * the looser transport type.
 */
interface VerificationView {
  level: string; basis: string; mode: "live" | "sandbox" | "internal";
  evidence: string; reason?: string;
}
interface ReceiptActionView {
  operation: string; platform?: string; target: string; status: string;
  detail: string; externalId?: string; verification?: VerificationView; draft?: string;
}
interface ReceiptView {
  taskId: string; businessId: string; objective: string; startedAt: string; finishedAt: string | null;
  finalStatus: string;
  actions: ReceiptActionView[];
  approvals: Array<{ kind: string; at: string; decision: string; payloadHash: string }>;
  recoveries: Array<{ step: string; attempt: number; reason: string; at: string }>;
  modelsUsed: string[];
  usage: { aiCalls: number; inputTokens: number; outputTokens: number; approxCostUsd: number };
  integrity: { algorithm: string; receiptHash: string; note: string };
}

const LEVEL_LABELS: Record<string, string> = {
  request_attempted: "Request attempted",
  provider_accepted: "Provider accepted",
  provider_id_returned: "Provider ID returned",
  object_confirmed: "Object confirmed",
  delivered: "Delivered (webhook receipt)",
  read: "Read (webhook receipt)",
  published: "Published (read-back confirmed)",
  objective_verified: "Objective independently verified",
  unverified: "Unverified"
};
const BASIS_LABELS: Record<string, string> = {
  provider_response: "provider response",
  platform_readback: "platform read-back",
  webhook_receipt: "webhook receipt",
  sandbox_state: "sandbox state",
  persisted_state: "persisted state",
  none: "no evidence"
};
const EXTERNAL_OPS = new Set(["send_approved_replies", "publish_approved_content"]);

function levelTone(level: string): string {
  if (level === "unverified") return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
  if (level === "object_confirmed" || level === "published" || level === "delivered" || level === "read" || level === "objective_verified")
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
  return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200";
}

/** A verification level is never rendered as a bare "verified": the level,
 *  its evidence basis, and the sandbox context (when applicable) travel together. */
function VerificationChip({ v }: { v: VerificationView }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${levelTone(v.level)}`}>
        {v.mode === "sandbox" ? "Sandbox · " : ""}{LEVEL_LABELS[v.level] ?? v.level}
      </span>
      <span className="text-[11px] text-slate-400">evidence: {BASIS_LABELS[v.basis] ?? v.basis}</span>
      {v.mode === "sandbox" && (
        <span className="inline-flex items-center rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-black tracking-wide text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">SANDBOX</span>
      )}
    </span>
  );
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function receiptToMarkdown(r: ReceiptView): string {
  const lines: string[] = [];
  lines.push(`# FounderFlo Ops — Activity Receipt`);
  lines.push(``);
  lines.push(`- **Objective:** ${r.objective}`);
  lines.push(`- **Task:** ${r.taskId}`);
  lines.push(`- **Final status:** ${r.finalStatus}`);
  lines.push(`- **Started:** ${r.startedAt}  **Finished:** ${r.finishedAt ?? "-"}`);
  lines.push(`- **Models used:** ${r.modelsUsed.join(", ") || "-"}`);
  lines.push(`- **Inference:** ${r.usage.aiCalls} AI calls · ${r.usage.inputTokens} tokens in / ${r.usage.outputTokens} out · approx. $${r.usage.approxCostUsd.toFixed(4)}`);
  if (r.actions.some((a) => a.verification?.mode === "sandbox")) {
    lines.push(``);
    lines.push(`> **SANDBOX RUN:** platform outcomes below were produced in the simulated sandbox environment, not on live Meta platforms.`);
  }
  lines.push(``);
  lines.push(`## Actions`);
  for (const a of r.actions) {
    lines.push(`- **${a.operation}**${a.platform ? ` (${a.platform})` : ""} → ${a.target}: ${a.status}`);
    lines.push(`  - ${a.detail}${a.externalId ? ` · external ID ${a.externalId}` : ""}`);
    if (a.verification) {
      lines.push(`  - Verification: **${LEVEL_LABELS[a.verification.level] ?? a.verification.level}** (${a.verification.mode}, evidence: ${BASIS_LABELS[a.verification.basis] ?? a.verification.basis}) — ${a.verification.evidence}${a.verification.reason ? ` Reason: ${a.verification.reason}` : ""}`);
    }
  }
  lines.push(``);
  lines.push(`## Approvals`);
  if (!r.approvals.length) lines.push(`- None.`);
  for (const a of r.approvals) lines.push(`- ${a.kind}: **${a.decision}** at ${a.at} · payload hash \`${a.payloadHash}\``);
  if (r.recoveries.length) {
    lines.push(``);
    lines.push(`## Recovery attempts`);
    for (const rec of r.recoveries) lines.push(`- Step ${rec.step}, attempt ${rec.attempt}: ${rec.reason}`);
  }
  lines.push(``);
  lines.push(`## Integrity`);
  lines.push(`- ${r.integrity.algorithm} checksum: \`${r.integrity.receiptHash}\``);
  lines.push(`- ${r.integrity.note}`);
  return lines.join("\n");
}

export default function Activity({ business, go }: { business: Business; go: (s: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [receiptFor, setReceiptFor] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await api.get<{ tasks: Task[] } | Task[]>(`/api/businesses/${business.id}/tasks`);
      setTasks(Array.isArray(res) ? res : res.tasks);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load activity"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  async function openReceipt(t: Task) {
    setReceiptFor(t); setReceipt(null); setReceiptLoading(true); setError("");
    try {
      const res = await api.get<ReceiptView>(`/api/tasks/${t.id}/receipt`);
      setReceipt(res);
    } catch (e) { setError(e instanceof Error ? e.message : "Receipt not available for this run yet"); }
    finally { setReceiptLoading(false); }
  }

  if (loading) return <Spinner label="Loading activity..." />;

  const externalActions = receipt?.actions.filter((a) => EXTERNAL_OPS.has(a.operation)) ?? [];
  const verifiedExternal = externalActions.filter((a) => a.verification);
  const isSandboxRun = receipt?.actions.some((a) => a.verification?.mode === "sandbox") ?? false;
  const auditActions = receipt?.actions.filter((a) => a.operation === "audit_draft") ?? [];
  const levelCounts = new Map<string, number>();
  for (const a of verifiedExternal) {
    const v = a.verification!;
    const key = `${v.mode === "sandbox" ? "sandbox · " : ""}${LEVEL_LABELS[v.level] ?? v.level}`;
    levelCounts.set(key, (levelCounts.get(key) ?? 0) + 1);
  }
  const failedActions = receipt?.actions.filter((a) => a.status === "failed" || a.status === "blocked") ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">Activity &amp; Proof</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Every operator run, with an evidence receipt. Each external action carries a verification level stating exactly what evidence backs the outcome — provider response, platform read-back, webhook receipt, or sandbox state. A level is never upgraded beyond its evidence, and sandbox outcomes are always labelled sandbox.</p>
      </div>
      {error && <ErrorBox message={error} />}

      {tasks.length === 0 ? (
        <EmptyState title="No runs yet" body="Completed, partial and failed operator runs will be listed here with their receipts."
          action={<button className={btnPrimary} onClick={() => go("operator")}>Start a run</button>} />
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 text-sm font-semibold">{t.objective}</p>
                <StatusBadge status={t.state} />
              </div>
              <p className="mt-1 text-xs text-slate-400">{fmtTime(t.createdAt)}{t.finishedAt ? ` → ${fmtTime(t.finishedAt)}` : ""}</p>
              <button className={`${btnSecondary} mt-2`} onClick={() => openReceipt(t)}>View receipt</button>
            </div>
          ))}
        </div>
      )}

      {receiptFor && (
        <Card className="slide-up">
          <SectionTitle right={receipt ? (
            <span className="flex gap-2">
              <button className={btnSecondary} onClick={() => downloadText(`metaops-receipt-${receipt.taskId}.md`, receiptToMarkdown(receipt))}>Download Markdown</button>
              <button className={btnPrimary} onClick={() => downloadJson(`metaops-receipt-${receipt.taskId}.json`, receipt)}>Download JSON</button>
            </span>
          ) : undefined}>
            Receipt
          </SectionTitle>
          <p className="mb-2 line-clamp-2 text-sm font-medium">{receiptFor.objective}</p>
          {receiptLoading && <Spinner label="Loading receipt..." />}
          {receipt && (
            <div className="space-y-4 text-sm">
              {isSandboxRun && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
                  <p className="font-black tracking-wide">SANDBOX RUN</p>
                  <p className="mt-0.5 text-xs">Every platform outcome in this receipt was produced in the simulated sandbox environment — not on live Meta platforms. Verification levels below describe evidence inside the sandbox only.</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <p><span className="font-semibold">Final status:</span> {receipt.finalStatus.replaceAll("_", " ")}</p>
                <p><span className="font-semibold">Models used:</span> {receipt.modelsUsed.join(", ") || "-"}</p>
                <p><span className="font-semibold">Started:</span> {fmtTime(receipt.startedAt)}</p>
                <p><span className="font-semibold">Finished:</span> {fmtTime(receipt.finishedAt)}</p>
                <p><span className="font-semibold">AI calls:</span> {receipt.usage.aiCalls} · Tokens in/out: {receipt.usage.inputTokens}/{receipt.usage.outputTokens}</p>
                <p><span className="font-semibold">Approx. inference cost:</span> ${receipt.usage.approxCostUsd.toFixed(4)}</p>
              </div>

              {externalActions.length > 0 && (
                <div className="rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
                  <p className="font-bold">Verification summary (external actions)</p>
                  {verifiedExternal.length === 0 ? (
                    <p className="mt-1 text-slate-500 dark:text-slate-400">This receipt predates structured verification levels. Action statuses are shown as recorded, without an evidence level — treat platform outcomes as unclassified, not verified.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5">
                      {[...levelCounts.entries()].map(([k, n]) => <li key={k}>{n} × {k}</li>)}
                      {verifiedExternal.length < externalActions.length && (
                        <li className="text-slate-400">{externalActions.length - verifiedExternal.length} external action(s) have no recorded verification level.</li>
                      )}
                    </ul>
                  )}
                </div>
              )}

              <div>
                <p className="mb-1 font-bold">Actions &amp; verification</p>
                {receipt.actions.length === 0 ? <p className="text-slate-400">No actions recorded.</p> : (
                  <ul className="space-y-1.5">
                    {receipt.actions.map((a, i) => (
                      <li key={i} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
                        <span className="font-semibold">{a.operation.replaceAll("_", " ")}</span>
                        {a.platform && <span className="capitalize text-slate-400"> · {a.platform}</span>}
                        <span className="text-slate-400"> · {a.target}</span>
                        <span className="ml-2"><StatusBadge status={a.status} /></span>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{a.detail}{a.externalId ? ` · ID ${a.externalId}` : ""}</p>
                        {a.verification && (
                          <>
                            <VerificationChip v={a.verification} />
                            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{a.verification.evidence}</p>
                            {a.verification.reason && <p className="mt-0.5 text-xs font-medium text-red-600 dark:text-red-300">Why not stronger: {a.verification.reason}</p>}
                          </>
                        )}
                        {EXTERNAL_OPS.has(a.operation) && !a.verification && a.status !== "pending_approval" && (
                          <p className="mt-0.5 text-xs text-slate-400">No verification level recorded for this action (legacy receipt).</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {auditActions.length > 0 && (
                <div>
                  <p className="mb-1 font-bold">Independent audit (drafts &amp; verdicts)</p>
                  <ul className="space-y-1.5">
                    {auditActions.map((a, i) => (
                      <li key={i} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
                        <span className="font-semibold">{a.status === "confirmed" ? "Auditor verdict: PASS" : a.status === "blocked" ? "Auditor verdict: BLOCKED" : "Auditor verdict: FAILED"}</span>
                        {a.platform && <span className="capitalize text-slate-400"> · {a.platform}</span>}
                        <span className="text-slate-400"> · {a.target}</span>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{a.detail}</p>
                        {a.draft && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs font-medium text-slate-500 dark:text-slate-300">Show the exact draft the auditor judged</summary>
                            <p className="mt-1 whitespace-pre-wrap rounded-md bg-white p-2 text-xs dark:bg-slate-900">{a.draft}</p>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="mb-1 font-bold">Approvals (payload-bound)</p>
                {receipt.approvals.length === 0 ? <p className="text-slate-400">No approvals were involved.</p> : (
                  <>
                    <ul className="space-y-1 text-xs">
                      {receipt.approvals.map((a, i) => (
                        <li key={i}>{a.kind} - <span className="font-semibold">{a.decision}</span> at {fmtTime(a.at)} · payload hash <span className="break-all font-mono">{a.payloadHash}</span></li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-slate-400">An approval binds the exact payload hash shown. Editing the payload afterwards invalidates the approval; what was approved is byte-for-byte what executes.</p>
                  </>
                )}
              </div>

              {(failedActions.length > 0 || receipt.recoveries.length > 0) && (
                <div>
                  <p className="mb-1 font-bold">Failures &amp; recovery</p>
                  <ul className="space-y-1 text-xs">
                    {failedActions.map((a, i) => (
                      <li key={`f${i}`}><span className="font-semibold">{a.operation}</span> ({a.target}): {a.status} — {a.detail}</li>
                    ))}
                    {receipt.recoveries.map((r, i) => (
                      <li key={`r${i}`}>Step {r.step}, attempt {r.attempt}: {r.reason} ({fmtTime(r.at)})</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
                <p><span className="font-semibold">Integrity:</span> {receipt.integrity.algorithm} checksum</p>
                <p className="mt-0.5 break-all font-mono">{receipt.integrity.receiptHash}</p>
                <p className="mt-0.5 text-slate-400">{receipt.integrity.note}</p>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
