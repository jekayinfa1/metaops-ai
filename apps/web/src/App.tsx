import { useCallback, useEffect, useState } from "react";
import { api, setToken, BUSINESS_KEY, type AiStatus, type Business } from "./lib/api";
import { getToken } from "./lib/api";
import Auth from "./screens/Auth";
import Dashboard from "./screens/Dashboard";
import Operator from "./screens/Operator";
import Inbox from "./screens/Inbox";
import Leads from "./screens/Leads";
import ContentStudio from "./screens/ContentStudio";
import Approvals from "./screens/Approvals";
import Activity from "./screens/Activity";
import Connections from "./screens/Connections";
import BusinessSettings from "./screens/BusinessSettings";
import { btnPrimary, Spinner } from "./components/ui";

type Screen = "dashboard" | "operator" | "inbox" | "leads" | "content" | "approvals" | "activity" | "connections" | "settings";

const NAV: Array<{ key: Screen; label: string; short: string }> = [
  { key: "dashboard", label: "Dashboard", short: "Home" },
  { key: "operator", label: "AI Operator", short: "Operator" },
  { key: "inbox", label: "Inbox", short: "Inbox" },
  { key: "leads", label: "Leads", short: "Leads" },
  { key: "content", label: "Content", short: "Content" },
  { key: "approvals", label: "Approvals", short: "Approvals" },
  { key: "activity", label: "Proof", short: "Proof" },
  { key: "connections", label: "Connections", short: "Connect" },
  { key: "settings", label: "Business", short: "Business" }
];

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(localStorage.getItem(BUSINESS_KEY));
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(() => localStorage.getItem("metaops_theme") === "dark" || (!localStorage.getItem("metaops_theme") && window.matchMedia?.("(prefers-color-scheme: dark)").matches));
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("metaops_theme", dark ? "dark" : "light");
  }, [dark]);

  const business = businesses.find((b) => b.id === businessId) ?? businesses[0] ?? null;

  const loadBusinesses = useCallback(async (selectId?: string) => {
    try {
      const res = await api.get<{ businesses: Business[] } | Business[]>("/api/businesses");
      const list = Array.isArray(res) ? res : res.businesses;
      setBusinesses(list);
      const wanted = selectId ?? businessId;
      const chosen = list.find((b) => b.id === wanted) ?? list[0] ?? null;
      if (chosen) { setBusinessId(chosen.id); localStorage.setItem(BUSINESS_KEY, chosen.id); }
      else { setBusinessId(null); localStorage.removeItem(BUSINESS_KEY); }
      return list;
    } catch { return []; }
  }, [businessId]);

  const loadStatus = useCallback(async () => {
    try { setAiStatus(await api.get<AiStatus>("/api/ai/status")); } catch { setAiStatus(null); }
  }, []);

  useEffect(() => {
    if (!authed) { setLoading(false); return; }
    setLoading(true);
    void Promise.all([loadBusinesses(), loadStatus()]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  useEffect(() => {
    if (!business) { setPendingCount(0); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get<{ approvals: Array<{ status: string }> } | Array<{ status: string }>>(`/api/approvals?businessId=${business.id}`);
        const list = Array.isArray(res) ? res : res.approvals;
        if (!cancelled) setPendingCount(list.filter((a) => a.status === "pending").length);
      } catch { /* badge is best-effort */ }
    };
    void tick();
    const id = window.setInterval(tick, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [business, screen]);

  function logout() {
    setToken(null);
    localStorage.removeItem(BUSINESS_KEY);
    setBusinesses([]); setBusinessId(null);
    setAuthed(false);
  }

  async function createBusiness() {
    const name = window.prompt("Business name:");
    if (!name?.trim()) return;
    try {
      const res = await api.post<{ business: Business } | Business>("/api/businesses", { name: name.trim() });
      const b = (res as { business?: Business }).business ?? (res as Business);
      await loadBusinesses(b.id);
      setScreen("settings");
    } catch { /* surfaced on the connections screen */ }
  }

  async function demoLoaded(id: string) {
    await loadBusinesses(id);
    setScreen("dashboard");
  }

  if (!authed) return <Auth onAuthed={() => setAuthed(true)} />;
  if (loading) return <div className="flex min-h-dvh items-center justify-center"><Spinner label="Loading MetaOps AI..." /></div>;

  const go = (s: string) => setScreen(s as Screen);

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-700 font-black text-white">M</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-black leading-tight">MetaOps AI</p>
            {businesses.length > 0 ? (
              <select aria-label="Active business" className="max-w-full bg-transparent text-xs text-slate-500 outline-none dark:text-slate-400"
                value={business?.id ?? ""} onChange={(e) => { setBusinessId(e.target.value); localStorage.setItem(BUSINESS_KEY, e.target.value); }}>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : (
              <p className="text-xs text-slate-400">No business yet</p>
            )}
          </div>
          <button onClick={() => setDark(!dark)} aria-label="Toggle dark mode"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-300 text-sm font-bold dark:border-slate-700">
            {dark ? "☀" : "☾"}
          </button>
          <button onClick={logout} className="min-h-[40px] rounded-xl px-2 text-sm font-semibold text-slate-500 dark:text-slate-400">Sign out</button>
        </div>
        {aiStatus && !aiStatus.configured && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200" role="status">
            Demo mode: deterministic planner - not Meta AI. ({aiStatus.fallbackModel ? `Fallback shown by server: ${aiStatus.fallbackModel}. ` : ""}Connect a Meta Model API key on the server to run {aiStatus.primaryModel} live.)
          </div>
        )}
        {aiStatus?.configured && (
          <div className="border-t border-emerald-200 bg-emerald-50 px-4 py-1.5 text-center text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200" role="status">
            Meta AI live: {aiStatus.primaryModel}{aiStatus.fallbackModel ? ` · fallback ${aiStatus.fallbackModel}` : ""}
          </div>
        )}
      </header>

      <div className="mx-auto flex max-w-5xl gap-0 lg:gap-6">
        <nav className="sticky top-[57px] hidden h-fit w-44 shrink-0 flex-col gap-1 px-3 py-4 lg:flex" aria-label="Primary">
          {NAV.map((n) => (
            <button key={n.key} onClick={() => setScreen(n.key)}
              className={`flex min-h-[44px] items-center justify-between rounded-xl px-3 text-left text-sm font-semibold ${screen === n.key ? "bg-sky-700 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"}`}>
              {n.label}
              {n.key === "approvals" && pendingCount > 0 && (
                <span className="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 px-4 pb-28 pt-4 lg:pb-10">
          {!business ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <h1 className="text-lg font-black">Welcome to MetaOps AI</h1>
                <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
                  First run: load the Harbor Goods demo to see the full workflow with sandbox connections and synthetic customers, or create your own business and connect real accounts.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button className={btnPrimary} onClick={() => setScreen("connections")}>Load Harbor Goods demo</button>
                  <button className={btnPrimary} onClick={createBusiness}>Create a business</button>
                </div>
              </div>
              {screen === "connections" && <Connections business={null} onDemoLoaded={demoLoaded} />}
            </div>
          ) : (
            <>
              {screen === "dashboard" && <Dashboard business={business} go={go} />}
              {screen === "operator" && <Operator business={business} go={go} />}
              {screen === "inbox" && <Inbox business={business} go={go} />}
              {screen === "leads" && <Leads business={business} go={go} />}
              {screen === "content" && <ContentStudio business={business} go={go} />}
              {screen === "approvals" && <Approvals business={business} />}
              {screen === "activity" && <Activity business={business} go={go} />}
              {screen === "connections" && <Connections business={business} onDemoLoaded={demoLoaded} />}
              {screen === "settings" && <BusinessSettings business={business} onBusinessChanged={(b) => setBusinesses((prev) => prev.map((x) => x.id === b.id ? b : x))} />}
            </>
          )}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 lg:hidden" aria-label="Primary mobile">
        <div className="grid grid-cols-5">
          {NAV.slice(0, 4).map((n) => (
            <button key={n.key} onClick={() => setScreen(n.key)}
              className={`relative flex min-h-[56px] flex-col items-center justify-center text-[11px] font-semibold ${screen === n.key ? "text-sky-700 dark:text-sky-300" : "text-slate-500 dark:text-slate-400"}`}>
              {n.short}
            </button>
          ))}
          <button onClick={() => setScreen("approvals")} className={`relative flex min-h-[56px] flex-col items-center justify-center text-[11px] font-semibold ${screen === "approvals" ? "text-sky-700 dark:text-sky-300" : "text-slate-500 dark:text-slate-400"}`}>
            Approvals
            {pendingCount > 0 && <span className="absolute right-3 top-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{pendingCount}</span>}
          </button>
        </div>
        <div className="grid grid-cols-4 border-t border-slate-100 dark:border-slate-900">
          {NAV.slice(5).map((n) => (
            <button key={n.key} onClick={() => setScreen(n.key)}
              className={`flex min-h-[44px] items-center justify-center text-[11px] font-semibold ${screen === n.key ? "text-sky-700 dark:text-sky-300" : "text-slate-500 dark:text-slate-400"}`}>
              {n.short}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
