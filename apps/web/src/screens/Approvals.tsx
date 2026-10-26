import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, type Approval, type Business } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, ModeBadge, PlatformBadge, EmptyState, btnPrimary, btnSecondary, btnDanger, inputCls, labelCls } from "../components/ui";

function payloadTextField(payload: Record<string, unknown>): string | null {
  for (const key of ["body", "caption", "text", "message"]) {
    if (typeof payload[key] === "string") return key;
  }
  return null;
}

export default function Approvals({ business }: { business: Business }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Approval | null>(null);
  const [editText, setEditText] = useState("");
  const [editJson, setEditJson] = useState("");
  const [editMode, setEditMode] = useState<"text" | "json">("text");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await api.get<{ approvals: Approval[] } | Approval[]>(`/api/approvals?businessId=${business.id}`);
      setApprovals(Array.isArray(res) ? res : res.approvals);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load approvals"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  async function decide(a: Approval, action: "approve" | "reject") {
    setBusyId(a.id); setError(""); setNotice("");
    try {
      await api.post(`/api/approvals/${a.id}/${action}`);
      setNotice(action === "approve" ? "Approved. The exact approved payload is what will be executed." : "Rejected. This action will not be executed.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : `Could not ${action}`); }
    finally { setBusyId(null); }
  }

  function startEdit(a: Approval) {
    setEditing(a);
    const field = payloadTextField(a.payload);
    if (field) { setEditMode("text"); setEditText(String(a.payload[field])); }
    else setEditMode("json");
    setEditJson(JSON.stringify(a.payload, null, 2));
  }

  async function saveEdit() {
    if (!editing) return;
    setBusyId(editing.id); setError(""); setNotice("");
    try {
      let payload: Record<string, unknown>;
      if (editMode === "text") {
        const field = payloadTextField(editing.payload) ?? "body";
        payload = { ...editing.payload, [field]: editText };
      } else {
        payload = JSON.parse(editJson) as Record<string, unknown>;
      }
      const res = await api.post<{ approval?: Approval } | Approval>(`/api/approvals/${editing.id}/edit`, { payload });
      const created = (res as { approval?: Approval }).approval ?? (res as Approval);
      setNotice(`Edit saved. The original approval was invalidated and a NEW pending approval${created?.id ? "" : ""} was created for the edited payload - it needs a fresh approval before anything runs.`);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof SyntaxError ? "Invalid JSON payload." : e instanceof Error ? e.message : "Could not save edit");
    } finally { setBusyId(null); }
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");

  if (loading) return <Spinner label="Loading approval queue..." />;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">Approvals</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Every external action - sending a customer message, publishing content - waits here first. Approval is bound to the exact payload hash shown; editing anything creates a new approval and invalidates the old one.</p>
      </div>
      {error && <ErrorBox message={error} />}
      {notice && <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{notice}</p>}

      <section>
        <SectionTitle>Pending ({pending.length})</SectionTitle>
        {pending.length === 0 ? (
          <EmptyState title="Queue is clear" body="When the AI Operator prepares a message or publication, it will appear here for your decision before anything leaves your accounts." />
        ) : (
          <div className="space-y-3">
            {pending.map((a) => (
              <Card key={a.id} className="slide-up">
                <div className="flex items-center gap-2">
                  <PlatformBadge platform={a.platform} />
                  <p className="flex-1 text-sm font-bold capitalize">{a.kind.replaceAll("_", " ")}</p>
                  <ModeBadge mode={a.mode} />
                  <StatusBadge status={a.status} />
                </div>
                <p className="mt-2 text-sm font-medium">{a.summary}</p>
                {a.accountName && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Account: {a.accountName}</p>}
                <div className="mt-2 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
                  {payloadTextField(a.payload) ? (
                    <p className="whitespace-pre-wrap">{String(a.payload[payloadTextField(a.payload)!])}</p>
                  ) : (
                    <pre className="overflow-x-auto text-xs">{JSON.stringify(a.payload, null, 2)}</pre>
                  )}
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  Expected effect: this {a.kind.replaceAll("_", " ")} will be executed on {a.platform} exactly as shown.
                  {a.mode === "sandbox" ? " Sandbox mode: executed against synthetic data, clearly recorded as sandbox." : ""}
                </p>
                <p className="mt-1 break-all font-mono text-[11px] text-slate-400">Payload hash: {a.payloadHash} · Requested {fmtTime(a.createdAt)}</p>

                {editing?.id === a.id ? (
                  <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <div className="flex gap-2">
                      <button type="button" className={editMode === "text" ? btnPrimary : btnSecondary} onClick={() => setEditMode("text")}>Text</button>
                      <button type="button" className={editMode === "json" ? btnPrimary : btnSecondary} onClick={() => setEditMode("json")}>JSON</button>
                    </div>
                    {editMode === "text" ? (
                      <div>
                        <label className={labelCls} htmlFor="edit-text">Edited content</label>
                        <textarea id="edit-text" rows={4} className={inputCls} value={editText} onChange={(e) => setEditText(e.target.value)} />
                      </div>
                    ) : (
                      <div>
                        <label className={labelCls} htmlFor="edit-json">Edited payload (JSON)</label>
                        <textarea id="edit-json" rows={7} className={`${inputCls} font-mono text-xs`} value={editJson} onChange={(e) => setEditJson(e.target.value)} />
                      </div>
                    )}
                    <p className="text-xs text-amber-600 dark:text-amber-300">Saving invalidates THIS approval and creates a new pending one for the edited payload.</p>
                    <div className="flex gap-2">
                      <button className={btnPrimary} disabled={busyId === a.id} onClick={saveEdit}>Save as new approval</button>
                      <button className={btnSecondary} onClick={() => setEditing(null)}>Cancel edit</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className={btnPrimary} disabled={busyId === a.id} onClick={() => decide(a, "approve")}>Approve</button>
                    <button className={btnDanger} disabled={busyId === a.id} onClick={() => decide(a, "reject")}>Reject</button>
                    <button className={btnSecondary} disabled={busyId === a.id} onClick={() => startEdit(a)}>Edit</button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section>
          <SectionTitle>History</SectionTitle>
          <div className="space-y-2">
            {history.map((a) => (
              <Card key={a.id} className="!p-3 opacity-80">
                <div className="flex items-center gap-2">
                  <PlatformBadge platform={a.platform} />
                  <p className="flex-1 truncate text-sm font-semibold">{a.summary}</p>
                  <StatusBadge status={a.status} />
                </div>
                <p className="mt-1 text-xs text-slate-400">{fmtTime(a.createdAt)} · hash {a.payloadHash.slice(0, 12)}...</p>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
