import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, type Business, type ContentItem, type Platform } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, ModeBadge, PlatformBadge, EmptyState, btnPrimary, inputCls, labelCls } from "../components/ui";

const GROUPS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "drafts", label: "Drafts", statuses: ["draft"] },
  { key: "approved", label: "Approved & scheduled", statuses: ["approved", "scheduled"] },
  { key: "published", label: "Published", statuses: ["published"] },
  { key: "attention", label: "Failed & unverified", statuses: ["failed", "unverified"] }
];

export default function ContentStudio({ business, go }: { business: Business; go: (s: string) => void }) {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ platform: "instagram" as Platform, kind: "post", brief: "", caption: "" });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await api.get<{ content: ContentItem[] } | ContentItem[]>(`/api/businesses/${business.id}/content`);
      setItems(Array.isArray(res) ? res : res.content);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load content"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true); setError(""); setNotice("");
    try {
      await api.post(`/api/businesses/${business.id}/content`, {
        platform: form.platform, kind: form.kind,
        brief: form.brief, caption: form.caption || undefined
      });
      setForm({ platform: "instagram", kind: "post", brief: "", caption: "" });
      setNotice("Draft created. Publishing always requires a separate approval in the Approvals queue.");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create draft"); }
    finally { setCreating(false); }
  }

  if (loading) return <Spinner label="Loading content studio..." />;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">Content Studio</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">AI-drafted Facebook and Instagram content, grounded in your approved business info and catalog. Nothing publishes without your approval, and publication is only marked confirmed when the platform (or sandbox) actually returns an ID.</p>
      </div>
      {error && <ErrorBox message={error} />}
      {notice && <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{notice}</p>}

      <Card>
        <SectionTitle>Create a draft</SectionTitle>
        <form onSubmit={create} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="ct-platform">Platform</label>
              <select id="ct-platform" className={inputCls} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="ct-kind">Format</label>
              <select id="ct-kind" className={inputCls} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="post">Post</option>
                <option value="reel">Reel</option>
                <option value="story">Story</option>
                <option value="announcement">Announcement</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="ct-brief">Campaign brief</label>
            <textarea id="ct-brief" rows={3} required className={inputCls} value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })}
              placeholder="Weekend promotion: 20% off candles on Saturday and Sunday, in-store and online." />
          </div>
          <div>
            <label className={labelCls} htmlFor="ct-caption">Caption (optional - AI drafts one from the brief if blank)</label>
            <textarea id="ct-caption" rows={3} className={inputCls} value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} />
          </div>
          <button type="submit" disabled={creating} className={`${btnPrimary} w-full`}>{creating ? "Creating..." : "Create draft"}</button>
        </form>
      </Card>

      {items.length === 0 ? (
        <EmptyState title="No content yet" body="Ask the AI Operator to prepare a campaign, or create a draft above."
          action={<button className={btnPrimary} onClick={() => go("operator")}>Ask the AI Operator</button>} />
      ) : (
        GROUPS.map((g) => {
          const group = items.filter((i) => g.statuses.includes(i.status));
          if (!group.length) return null;
          return (
            <section key={g.key}>
              <SectionTitle>{g.label}</SectionTitle>
              <div className="space-y-2">
                {group.map((i) => (
                  <Card key={i.id} className="!p-3">
                    <div className="flex items-center gap-2">
                      <PlatformBadge platform={i.platform} />
                      <p className="flex-1 text-sm font-semibold capitalize">{i.platform} {i.kind}</p>
                      <ModeBadge mode={i.mode} />
                      <StatusBadge status={i.status} />
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{i.caption}</p>
                    <p className="mt-2 text-xs text-slate-400">
                      {i.status === "published" && i.externalId ? `Published · platform ID ${i.externalId}` : ""}
                      {i.status === "published" && !i.externalId ? "Marked published without a platform ID - treat as unverified." : ""}
                      {i.scheduledFor ? `Scheduled for ${fmtTime(i.scheduledFor)}` : ""}
                      {i.status === "draft" ? "Draft - request publishing from the AI Operator or approve a pending publishing approval." : ""}
                    </p>
                  </Card>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
