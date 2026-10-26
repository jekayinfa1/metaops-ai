import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, HERO_OBJECTIVE, fmtTime, type Business, type Task, type TaskStep } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, btnPrimary, btnSecondary, btnDanger, inputCls, labelCls } from "../components/ui";

const ACTIVE_STATES = ["created", "planning", "running", "verifying", "recovering", "awaiting_connection", "awaiting_permission", "awaiting_approval", "paused"];

export default function Operator({ business, go }: { business: Business; go: (s: string) => void }) {
  const [objective, setObjective] = useState(HERO_OBJECTIVE);
  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const res = await api.get<{ tasks: Task[] } | Task[]>(`/api/businesses/${business.id}/tasks`);
      const list = Array.isArray(res) ? res : res.tasks;
      setTasks(list);
      return list;
    } catch { return []; }
  }, [business.id]);

  const loadTask = useCallback(async (id: string) => {
    try {
      const res = await api.get<{ task: Task; steps: TaskStep[] }>(`/api/tasks/${id}`);
      setTask(res.task);
      if (res.steps) setSteps(res.steps);
      else if (res.task.plan?.steps) setSteps(res.task.plan.steps);
      return res.task;
    } catch { return null; }
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  const stopStreams = useCallback(() => {
    esRef.current?.close(); esRef.current = null;
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const watch = useCallback((id: string) => {
    stopStreams();
    const token = getToken();
    try {
      const es = new EventSource(`/api/tasks/${id}/events?token=${encodeURIComponent(token ?? "")}`);
      esRef.current = es;
      es.onmessage = () => { void loadTask(id); void loadTasks(); };
      es.onerror = () => { /* polling below covers gaps */ };
    } catch { /* EventSource unsupported - polling only */ }
    pollRef.current = window.setInterval(async () => {
      const t = await loadTask(id);
      await loadTasks();
      if (t && !ACTIVE_STATES.includes(t.state)) stopStreams();
    }, 2500);
  }, [loadTask, loadTasks, stopStreams]);

  useEffect(() => stopStreams, [stopStreams]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setTask(null); setSteps([]);
    try {
      const res = await api.post<{ task: Task }>(`/api/businesses/${business.id}/tasks`, { objective });
      setTask(res.task);
      await loadTask(res.task.id);
      watch(res.task.id);
      await loadTasks();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not start the run"); }
    finally { setBusy(false); }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!task) return;
    setError("");
    try {
      await api.post(`/api/tasks/${task.id}/${action}`);
      const t = await loadTask(task.id);
      if (action === "resume" && t) watch(task.id);
      if (action === "cancel") stopStreams();
      await loadTasks();
    } catch (err) { setError(err instanceof Error ? err.message : `Could not ${action} the run`); }
  }

  async function openTask(t: Task) {
    const full = await loadTask(t.id);
    if (full && ACTIVE_STATES.includes(full.state)) watch(t.id);
  }

  const planSteps: TaskStep[] = steps.length ? steps : (task?.plan?.steps ?? []);
  const showPlanPreview = !task;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">AI Operator</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Describe the outcome. MetaOps plans the steps, executes only authorized operations, pauses for your approval on anything external, then verifies the result.</p>
      </div>

      <Card>
        <form onSubmit={run} className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="objective">Objective for {business.name}</label>
            <textarea id="objective" rows={4} className={inputCls} value={objective} onChange={(e) => setObjective(e.target.value)} required minLength={10} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} onClick={() => setObjective(HERO_OBJECTIVE)}>Use hero demo objective</button>
            <button type="button" className={btnSecondary} onClick={() => setObjective("Find the customers who asked about pricing today, prepare helpful replies using our product catalog, and show me what needs approval.")}>Pricing inquiries</button>
            <button type="button" className={btnSecondary} onClick={() => setObjective("Create three Instagram post drafts for our weekend promotion and prepare a Facebook announcement.")}>Weekend promotion content</button>
          </div>
          <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>{busy ? "Starting..." : "Run with AI Operator"}</button>
        </form>
        {showPlanPreview && (
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Typical plan for this kind of objective</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
              <li>Retrieve eligible new inquiries</li>
              <li>Classify conversations by intent and draft grounded replies</li>
              <li>Request your approval before any message is sent</li>
              <li>Send approved replies and identify sales leads</li>
              <li>Create content drafts and request publishing approval</li>
              <li>Verify results against platform / sandbox state and generate a proof report</li>
            </ol>
            <p className="mt-2 text-xs text-slate-400">The actual plan is generated when the run starts and is shown step by step below.</p>
          </div>
        )}
      </Card>

      {error && <ErrorBox message={error} />}

      {task && (
        <Card className="slide-up">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold">Current run</p>
              <p className="mt-0.5 line-clamp-3 text-sm text-slate-600 dark:text-slate-300">{task.objective}</p>
              <p className="mt-1 text-xs text-slate-400">Started {fmtTime(task.createdAt)}{task.finishedAt ? ` · Finished ${fmtTime(task.finishedAt)}` : ""}</p>
            </div>
            <StatusBadge status={task.state} />
          </div>

          {planSteps.length > 0 ? (
            <ol className="mt-4 space-y-2">
              {planSteps.map((s, i) => (
                <li key={i} className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    s.status === "completed" || s.status === "confirmed" ? "bg-emerald-600 text-white"
                    : s.status === "failed" || s.status === "blocked" ? "bg-red-600 text-white"
                    : s.status === "running" || s.status === "in_progress" ? "bg-sky-600 text-white pulse-soft"
                    : "bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200"}`}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {s.operation.replaceAll("_", " ")}
                      {s.platform && <span className="ml-2 text-xs font-medium capitalize text-slate-400">{s.platform}</span>}
                      {s.requiresApproval && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">Needs approval</span>}
                    </p>
                    {s.detail && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{s.detail}</p>}
                  </div>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ol>
          ) : (
            <div className="mt-4"><Spinner label="Planning..." /></div>
          )}

          {task.state === "awaiting_approval" && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
              This run is waiting on approvals before it sends or publishes anything.
              <button className={`${btnPrimary} ml-0 mt-2 w-full sm:ml-3 sm:mt-0 sm:w-auto`} onClick={() => go("approvals")}>Review approvals</button>
            </div>
          )}
          {task.failureReason && <div className="mt-3"><ErrorBox message={String(task.failureReason)} /></div>}

          <div className="mt-4 flex flex-wrap gap-2">
            {task.state === "paused" ? (
              <button className={btnPrimary} onClick={() => control("resume")}>Resume</button>
            ) : ACTIVE_STATES.includes(task.state) ? (
              <button className={btnSecondary} onClick={() => control("pause")}>Pause</button>
            ) : null}
            {ACTIVE_STATES.includes(task.state) && (
              <button className={btnDanger} onClick={() => control("cancel")}>Cancel run</button>
            )}
            {(task.state === "completed" || task.state === "partially_completed" || task.state === "failed") && (
              <button className={btnSecondary} onClick={() => go("activity")}>View proof receipt</button>
            )}
          </div>
        </Card>
      )}

      <section>
        <SectionTitle>Previous runs</SectionTitle>
        {tasks.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">No runs yet for this business.</p>
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <button key={t.id} onClick={() => openTask(t)} className="block w-full rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm dark:border-slate-800 dark:bg-slate-900">
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
