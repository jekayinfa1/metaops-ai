import { useCallback, useEffect, useState } from "react";
import { api, downloadJson, fmtTime, type ActivityReceipt, type Business, type Task } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, EmptyState, btnPrimary, btnSecondary } from "../components/ui";

export default function Activity({ business, go }: { business: Business; go: (s: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [receipt, setReceipt] = useState<ActivityReceipt | null>(null);
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
      const res = await api.get<ActivityReceipt>(`/api/tasks/${t.id}/receipt`);
      setReceipt(res);
    } catch (e) { setError(e instanceof Error ? e.message : "Receipt not available for this run yet"); }
    finally { setReceiptLoading(false); }
  }

  if (loading) return <Spinner label="Loading activity..." />;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">Activity &amp; Proof</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Every operator run, with an evidence receipt. An outcome is only called verified when a platform response, platform object ID, webhook, or persisted state backs it - never just because the AI said so.</p>
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
          <SectionTitle right={receipt ? <button className={btnPrimary} onClick={() => downloadJson(`metaops-receipt-${receipt.taskId}.json`, receipt)}>Download JSON</button> : undefined}>
            Receipt
          </SectionTitle>
          <p className="mb-2 line-clamp-2 text-sm font-medium">{receiptFor.objective}</p>
          {receiptLoading && <Spinner label="Loading receipt..." />}
          {receipt && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <p><span className="font-semibold">Final status:</span> {receipt.finalStatus.replaceAll("_", " ")}</p>
                <p><span className="font-semibold">Models used:</span> {receipt.modelsUsed.join(", ") || "-"}</p>
                <p><span className="font-semibold">Started:</span> {fmtTime(receipt.startedAt)}</p>
                <p><span className="font-semibold">Finished:</span> {fmtTime(receipt.finishedAt)}</p>
                <p><span className="font-semibold">AI calls:</span> {receipt.usage.aiCalls} · Tokens in/out: {receipt.usage.inputTokens}/{receipt.usage.outputTokens}</p>
                <p><span className="font-semibold">Approx. inference cost:</span> ${receipt.usage.approxCostUsd.toFixed(4)}</p>
              </div>

              <div>
                <p className="mb-1 font-bold">Actions</p>
                {receipt.actions.length === 0 ? <p className="text-slate-400">No actions recorded.</p> : (
                  <ul className="space-y-1.5">
                    {receipt.actions.map((a, i) => (
                      <li key={i} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
                        <span className="font-semibold">{a.operation.replaceAll("_", " ")}</span>
                        {a.platform && <span className="capitalize text-slate-400"> · {a.platform}</span>}
                        <span className="text-slate-400"> · {a.target}</span>
                        <span className="ml-2"><StatusBadge status={a.status} /></span>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{a.detail}{a.externalId ? ` · ID ${a.externalId}` : ""}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="mb-1 font-bold">Approvals</p>
                {receipt.approvals.length === 0 ? <p className="text-slate-400">No approvals were involved.</p> : (
                  <ul className="space-y-1 text-xs">
                    {receipt.approvals.map((a, i) => (
                      <li key={i}>{a.kind} - <span className="font-semibold">{a.decision}</span> at {fmtTime(a.at)} · payload hash {a.payloadHash.slice(0, 16)}...</li>
                    ))}
                  </ul>
                )}
              </div>

              {receipt.recoveries.length > 0 && (
                <div>
                  <p className="mb-1 font-bold">Recovery attempts</p>
                  <ul className="space-y-1 text-xs">
                    {receipt.recoveries.map((r, i) => (
                      <li key={i}>Step {r.step}, attempt {r.attempt}: {r.reason} ({fmtTime(r.at)})</li>
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
