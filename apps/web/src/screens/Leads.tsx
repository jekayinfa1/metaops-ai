import { useCallback, useEffect, useState } from "react";
import { api, type Business, type Lead } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, PlatformBadge, EmptyState, btnPrimary } from "../components/ui";
import { categoryLabel } from "./Inbox";

const PRIORITY_CLS: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  low: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  none: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
};

export default function Leads({ business, go }: { business: Business; go: (s: string) => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await api.get<{ leads: Lead[] } | Lead[]>(`/api/businesses/${business.id}/leads`);
      setLeads(Array.isArray(res) ? res : res.leads);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load leads"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="Loading leads..." />;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black tracking-tight">Leads</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Customers who showed buying signals, organized from permitted conversations. Priority is an AI suggestion with its reasoning shown - it is not verified purchase intent.</p>
      </div>
      {error && <ErrorBox message={error} />}
      {leads.length === 0 ? (
        <EmptyState title="No leads yet" body="Run the AI Operator over today's inquiries and customers expressing purchase interest will be collected here."
          action={<button className={btnPrimary} onClick={() => go("operator")}>Run the AI Operator</button>} />
      ) : (
        <div className="space-y-2">
          <SectionTitle>{leads.length} lead{leads.length === 1 ? "" : "s"}</SectionTitle>
          {leads.map((l) => (
            <Card key={l.id} className="!p-3">
              <div className="flex items-center gap-3">
                <PlatformBadge platform={l.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{l.customerName}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{categoryLabel(l.category)}{l.productInterest ? ` · Interested in: ${l.productInterest}` : ""}</p>
                </div>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${PRIORITY_CLS[l.priority] ?? PRIORITY_CLS.low}`}>{l.priority} priority</span>
                <StatusBadge status={l.status} />
              </div>
              {l.explanation && (
                <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  <span className="font-semibold">Why this priority (AI suggestion): </span>{l.explanation}
                </p>
              )}
              <p className="mt-2 text-xs text-slate-400">
                Follow-up: {l.followUpEligible ? "Permitted - inside the platform messaging window / consent on file. Sending still needs your approval." : "Not currently permitted (outside messaging window or no consent). No message will be sent."}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
