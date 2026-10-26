import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, type Business, type Connection, type Task, type Approval } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, ModeBadge, PlatformBadge, EmptyState, btnPrimary } from "../components/ui";

export default function Dashboard({ business, go }: { business: Business; go: (s: string) => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [c, a, t] = await Promise.all([
        api.get<{ connections: Connection[] } | Connection[]>(`/api/businesses/${business.id}/connections`),
        api.get<{ approvals: Approval[] } | Approval[]>(`/api/approvals?businessId=${business.id}`),
        api.get<{ tasks: Task[] } | Task[]>(`/api/businesses/${business.id}/tasks`)
      ]);
      setConnections(Array.isArray(c) ? c : c.connections);
      setApprovals(Array.isArray(a) ? a : a.approvals);
      setTasks(Array.isArray(t) ? t : t.tasks);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load dashboard"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  const pending = approvals.filter((a) => a.status === "pending");
  const recent = [...tasks].slice(0, 5);

  if (loading) return <Spinner label="Loading your business overview..." />;
  return (
    <div className="space-y-5">
      {error && <ErrorBox message={error} />}
      <div>
        <h1 className="text-xl font-black tracking-tight">{business.name}</h1>
        {business.description && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{business.description}</p>}
        {business.location && <p className="text-xs text-slate-400">{business.location}{business.hours ? ` · ${business.hours}` : ""}</p>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <button onClick={() => go("approvals")} className="rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <p className="text-2xl font-black">{pending.length}</p>
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Pending approvals</p>
        </button>
        <button onClick={() => go("connections")} className="rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <p className="text-2xl font-black">{connections.length}</p>
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Connected accounts</p>
        </button>
        <button onClick={() => go("activity")} className="rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <p className="text-2xl font-black">{tasks.length}</p>
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Operator runs</p>
        </button>
      </div>

      <section>
        <SectionTitle right={<button className="text-sm font-semibold text-sky-700 dark:text-sky-300" onClick={() => go("connections")}>Manage</button>}>Connected accounts</SectionTitle>
        {connections.length === 0 ? (
          <EmptyState title="No accounts connected" body="Connect a Facebook Page, Instagram professional account, Messenger or WhatsApp Business account, or load the Harbor Goods demo to explore with sandbox data."
            action={<button className={btnPrimary} onClick={() => go("connections")}>Go to Connections</button>} />
        ) : (
          <div className="space-y-2">
            {connections.map((c) => (
              <Card key={c.id} className="flex items-center gap-3 !p-3">
                <PlatformBadge platform={c.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{c.displayName}</p>
                  <p className="text-xs capitalize text-slate-500 dark:text-slate-400">{c.platform} · {c.status}</p>
                </div>
                <ModeBadge mode={c.mode} />
              </Card>
            ))}
          </div>
        )}
      </section>

      {pending.length > 0 && (
        <section>
          <SectionTitle>Needs your approval</SectionTitle>
          <div className="space-y-2">
            {pending.slice(0, 3).map((a) => (
              <button key={a.id} onClick={() => go("approvals")} className="block w-full rounded-2xl border border-amber-300 bg-amber-50 p-3 text-left dark:border-amber-800 dark:bg-amber-950/40">
                <p className="text-sm font-semibold">{a.summary}</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{a.platform} · {fmtTime(a.createdAt)}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle right={<button className="text-sm font-semibold text-sky-700 dark:text-sky-300" onClick={() => go("operator")}>New run</button>}>Recent activity</SectionTitle>
        {recent.length === 0 ? (
          <EmptyState title="No operator runs yet" body="Give the AI Operator a goal, for example: handle today's inquiries, identify buyers, and prepare tomorrow's promotion."
            action={<button className={btnPrimary} onClick={() => go("operator")}>Open AI Operator</button>} />
        ) : (
          <div className="space-y-2">
            {recent.map((t) => (
              <button key={t.id} onClick={() => go("activity")} className="block w-full rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 text-sm font-semibold">{t.objective}</p>
                  <StatusBadge status={t.state} />
                </div>
                <p className="mt-1 text-xs text-slate-400">{fmtTime(t.createdAt)}</p>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
