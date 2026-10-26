import { useCallback, useEffect, useState } from "react";
import { api, type Business, type Connection, type Platform } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, ModeBadge, PlatformBadge, btnPrimary, inputCls, labelCls } from "../components/ui";

const PLATFORMS: Array<{ key: Platform; name: string; blurb: string }> = [
  { key: "facebook", name: "Facebook Page", blurb: "Page posts, comments and engagement insights." },
  { key: "instagram", name: "Instagram Professional", blurb: "Media, comments, insights and messaging for professional accounts." },
  { key: "messenger", name: "Messenger", blurb: "Customer conversations through your Page, within platform messaging windows." },
  { key: "whatsapp", name: "WhatsApp Business", blurb: "Cloud API conversations, approved templates and delivery status. Opt-in required." }
];

export default function Connections({ business, onDemoLoaded }: { business: Business | null; onDemoLoaded: (businessId: string) => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [form, setForm] = useState<{ platform: Platform; mode: "sandbox" | "live"; displayName: string; externalAccountId: string; accessToken: string }>({
    platform: "facebook", mode: "sandbox", displayName: "", externalAccountId: "", accessToken: ""
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!business) { setConnections([]); return; }
    setLoading(true); setError("");
    try {
      const res = await api.get<{ connections: Connection[] } | Connection[]>(`/api/businesses/${business.id}/connections`);
      setConnections(Array.isArray(res) ? res : res.connections);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load connections"); }
    finally { setLoading(false); }
  }, [business]);

  useEffect(() => { void load(); }, [load]);

  async function seedDemo() {
    setSeeding(true); setError(""); setNotice("");
    try {
      const res = await api.post<{ businessId: string }>("/api/demo/seed");
      setNotice("Harbor Goods demo loaded: a synthetic business with sandbox connections and a synthetic inbox. All demo activity is labeled Sandbox.");
      onDemoLoaded(res.businessId);
    } catch (e) { setError(e instanceof Error ? e.message : "Demo seed failed"); }
    finally { setSeeding(false); }
  }


  async function connectWithFacebook() {
    if (!business) return;
    setError(""); setNotice("");
    try {
      const res = await api.get<{ url: string }>(`/api/oauth/facebook/start?businessId=${business.id}`);
      window.location.assign(res.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Facebook connect is unavailable right now.");
    }
  }

  async function addConnection(e: React.FormEvent) {
    e.preventDefault();
    if (!business) return;
    setSaving(true); setError("");
    try {
      await api.post(`/api/businesses/${business.id}/connections`, {
        platform: form.platform,
        mode: form.mode,
        displayName: form.displayName || `${form.platform} account`,
        externalAccountId: form.externalAccountId || undefined,
        accessToken: form.mode === "live" ? form.accessToken || undefined : undefined
      });
      setForm({ platform: "facebook", mode: "sandbox", displayName: "", externalAccountId: "", accessToken: "" });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not add connection"); }
    finally { setSaving(false); }
  }

  async function remove(id: string) {
    setError("");
    try { await api.del(`/api/connections/${id}`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not remove connection"); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">Connections</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Authorize Meta business accounts. Live connections use official Meta APIs; sandbox connections run the full workflow against synthetic data and are always labeled Sandbox.</p>
      </div>

      <Card className="border-sky-300 dark:border-sky-800">
        <SectionTitle>Harbor Goods demo</SectionTitle>
        <p className="text-sm text-slate-600 dark:text-slate-300">Load a fictional small business with products, sandbox Facebook / Instagram / WhatsApp connections and synthetic customer inquiries. Best way to see the full hero workflow.</p>
        <button className={`${btnPrimary} mt-3`} onClick={seedDemo} disabled={seeding}>{seeding ? "Loading demo..." : "Load Harbor Goods demo"}</button>
        {notice && <p className="mt-3 rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{notice}</p>}
      </Card>

      {error && <ErrorBox message={error} />}
      {loading && <Spinner label="Loading connections..." />}

      {business && connections.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>{business.name} accounts</SectionTitle>
          {connections.map((c) => (
            <Card key={c.id} className="!p-3">
              <div className="flex items-center gap-3">
                <PlatformBadge platform={c.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{c.displayName}</p>
                  <p className="text-xs capitalize text-slate-500 dark:text-slate-400">{c.platform} · {c.status}{c.externalAccountId ? ` · ${c.externalAccountId}` : ""}</p>
                </div>
                <ModeBadge mode={c.mode} />
                <button className="text-sm font-semibold text-red-600" onClick={() => remove(c.id)} aria-label={`Disconnect ${c.displayName}`}>Disconnect</button>
              </div>
              {c.capabilities?.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
                  {c.capabilities.map((cap) => (
                    <li key={cap.key} className="flex items-start gap-2 text-xs">
                      <span className={cap.available ? "text-emerald-600" : "text-red-500"} aria-hidden>{cap.available ? "●" : "○"}</span>
                      <span className="flex-1">
                        <span className="font-medium">{cap.label}</span>
                        {!cap.available && cap.reason && <span className="block text-slate-500 dark:text-slate-400">Unavailable: {cap.reason}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </section>
      )}

      {business ? (
        <Card>
          <SectionTitle>Add a connection</SectionTitle>
          {business && (
            <div className="mb-4 rounded border p-3">
              <p className="mb-2 text-sm">Recommended: sign in with Facebook and pick your Pages. MetaOps receives a long-lived Page token, stored encrypted on the server — no copying tokens by hand.</p>
              <button type="button" className="rounded bg-black px-4 py-2 text-white" onClick={() => void connectWithFacebook()}>
                Connect with Facebook
              </button>
            </div>
          )}
          <form onSubmit={addConnection} className="space-y-3">
            <div>
              <label className={labelCls} htmlFor="c-platform">Platform</label>
              <select id="c-platform" className={inputCls} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}>
                {PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-400">{PLATFORMS.find((p) => p.key === form.platform)?.blurb}</p>
            </div>
            <div>
              <label className={labelCls}>Mode</label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Connection mode">
                {(["sandbox", "live"] as const).map((m) => (
                  <button type="button" key={m} role="radio" aria-checked={form.mode === m}
                    onClick={() => setForm({ ...form, mode: m })}
                    className={`min-h-[44px] rounded-xl border px-3 text-sm font-semibold capitalize ${form.mode === m ? "border-sky-600 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200" : "border-slate-300 dark:border-slate-700"}`}>
                    {m}{m === "sandbox" ? " (synthetic data)" : " (official API)"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="c-name">Display name</label>
              <input id="c-name" className={inputCls} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Harbor Goods Page" />
            </div>
            <div>
              <label className={labelCls} htmlFor="c-ext">External account ID (optional)</label>
              <input id="c-ext" className={inputCls} value={form.externalAccountId} onChange={(e) => setForm({ ...form, externalAccountId: e.target.value })} placeholder="Page / IG / WABA id" />
            </div>
            {form.mode === "live" && (
              <div>
                <label className={labelCls} htmlFor="c-token">Meta access token</label>
                <input id="c-token" type="password" autoComplete="off" className={inputCls} value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} placeholder="Paste token - stored encrypted server-side" />
                <p className="mt-1 text-xs text-slate-400">Sent once over this connection, encrypted at rest, and never returned to the browser.</p>
              </div>
            )}
            <button type="submit" disabled={saving} className={`${btnPrimary} w-full`}>{saving ? "Connecting..." : "Connect account"}</button>
          </form>
        </Card>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">Create or load a business first (the Harbor Goods demo above is the fastest path), then connect its accounts here.</p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {PLATFORMS.map((p) => (
          <Card key={p.key} className="!p-3">
            <div className="flex items-center gap-2"><PlatformBadge platform={p.key} /><p className="text-sm font-semibold">{p.name}</p></div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{p.blurb}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
