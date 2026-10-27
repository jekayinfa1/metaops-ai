import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, type Business, type Conversation, type Message, type Platform } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, StatusBadge, PlatformBadge, EmptyState, btnPrimary, btnSecondary } from "../components/ui";

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "messenger", label: "Messenger" },
  { key: "whatsapp", label: "WhatsApp" }
];

export function categoryLabel(c: string | null | undefined): string {
  if (!c) return "Not yet classified";
  return ({
    product_question: "Product question", pricing: "Pricing", availability: "Availability",
    order_support: "Order support", complaint: "Complaint", booking: "Booking request",
    sales_interest: "Sales interest", general: "General"
  } as Record<string, string>)[c] ?? c.replaceAll("_", " ");
}

export default function Inbox({ business, go }: { business: Business; go: (s: string) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await api.get<{ conversations: Conversation[] } | Conversation[]>(`/api/businesses/${business.id}/conversations`);
      setConversations(Array.isArray(res) ? res : res.conversations);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load inbox"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  async function open(c: Conversation) {
    setSelected(c); setThreadLoading(true); setMessages([]);
    try {
      const res = await api.get<{ messages: Message[] } | Message[]>(`/api/conversations/${c.id}/messages`);
      setMessages(Array.isArray(res) ? res : res.messages);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load thread"); }
    finally { setThreadLoading(false); }
  }

  const visible = conversations.filter((c) => filter === "all" || c.platform === (filter as Platform));

  if (loading) return <Spinner label="Loading unified inbox..." />;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black tracking-tight">Unified Inbox</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Customer inquiries from every connected Meta account, classified and paired with a grounded suggested reply. Nothing is sent without your approval.</p>
      </div>
      {error && <ErrorBox message={error} />}

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Platform filter">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
            className={`min-h-[40px] shrink-0 rounded-full px-4 text-sm font-semibold ${filter === f.key ? "bg-sky-700 text-white" : "border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No conversations here" body="When customers message your connected accounts, their inquiries appear here with an AI classification and a suggested reply."
          action={<button className={btnPrimary} onClick={() => go("connections")}>Check connections</button>} />
      ) : (
        <div className="space-y-2">
          {visible.map((c) => (
            <button key={c.id} onClick={() => open(c)} className={`block w-full rounded-2xl border p-3 text-left shadow-sm ${selected?.id === c.id ? "border-sky-500 bg-sky-50 dark:bg-sky-950/40" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"}`}>
              <div className="flex items-center gap-3">
                <PlatformBadge platform={c.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{c.customerName}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{categoryLabel(c.category)} · Lead: {c.leadStatus.replaceAll("_", " ")}</p>
                </div>
                <div className="text-right">
                  <StatusBadge status={c.workflowState} />
                  <p className="mt-1 text-[11px] text-slate-400">{fmtTime(c.lastMessageAt)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <Card className="slide-up">
          <SectionTitle right={<button className={btnSecondary} onClick={() => setSelected(null)}>Close</button>}>
            <span className="flex items-center gap-2"><PlatformBadge platform={selected.platform} /> {selected.customerName}</span>
          </SectionTitle>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            {categoryLabel(selected.category)} · Lead status: {selected.leadStatus.replaceAll("_", " ")} · State: {selected.workflowState.replaceAll("_", " ")}
          </p>
          {threadLoading ? <Spinner label="Loading thread..." /> : (
            <div className="space-y-2">
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.direction === "inbound" ? "bg-slate-100 dark:bg-slate-800" : "ml-auto bg-sky-700 text-white"}`}>
                  <p>{m.body}</p>
                  <p className={`mt-1 text-[11px] ${m.direction === "inbound" ? "text-slate-400" : "text-sky-200"}`}>{fmtTime(m.at)} · {m.status}</p>
                </div>
              ))}
              {messages.length === 0 && <p className="text-sm text-slate-400">No messages returned for this conversation.</p>}
            </div>
          )}
          {selected.suggestedReply && (
            <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950/50">
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">AI suggested reply (draft - not sent)</p>
              <p className="mt-1 text-sm">{selected.suggestedReply}</p>
              <button className={`${btnPrimary} mt-3`} onClick={() => go("approvals")}>Review in Approvals before sending</button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
