import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface OAuthPage {
  pageId: string;
  name: string;
  category: string;
  perms: string[];
  instagram: { id: string; name: string } | null;
}

const ERROR_TEXT: Record<string, string> = {
  oauth_denied: "Facebook sign-in was cancelled or denied, so nothing was connected.",
  state_invalid: "This connect link expired or was already used. Start again from the Connections screen.",
  oauth_not_configured: "Facebook connect is not configured on this server yet (the operator must set the Meta app credentials).",
  exchange_failed: "Facebook did not complete the sign-in exchange. Nothing was connected; you can try again.",
  no_pages: "That Facebook account does not manage any Pages, so there is nothing to connect."
};

export default function OAuthDone() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  const errorCode = params.get("error");
  const [pages, setPages] = useState<OAuthPage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"loading" | "ready" | "connecting" | "done" | "error">("loading");
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState<Array<{ platform: string; displayName: string }>>([]);

  useEffect(() => {
    if (errorCode) { setState("error"); setMessage(ERROR_TEXT[errorCode] ?? "Facebook connect did not complete."); return; }
    if (!session) { setState("error"); setMessage("This page was opened without a connect session. Start from the Connections screen."); return; }
    api.get<{ pages: OAuthPage[] }>(`/api/oauth/facebook/pages?session=${encodeURIComponent(session)}`)
      .then((res) => { setPages(res.pages); setSelected(new Set(res.pages.map((p) => p.pageId))); setState("ready"); })
      .catch((e) => { setState("error"); setMessage(e instanceof Error ? e.message : "Could not load your Pages."); });
  }, [session, errorCode]);

  async function connect() {
    if (!session) return;
    setState("connecting");
    try {
      const res = await api.post<{ connected: Array<{ platform: string; displayName: string }> }>("/api/oauth/facebook/connect", {
        session, pageIds: [...selected]
      });
      setConnected(res.connected);
      setState("done");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Could not create the connections.");
    }
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-xl font-semibold mb-2">Connect your Facebook Pages</h1>
      {state === "loading" && <p>Loading your Pages from Facebook…</p>}
      {state === "error" && (
        <div>
          <p className="mb-4">{message}</p>
          <a className="underline" href="/">Back to MetaOps</a>
        </div>
      )}
      {(state === "ready" || state === "connecting") && (
        <div>
          <p className="mb-4">Choose which Pages MetaOps should operate. A linked Instagram professional account is connected automatically with its Page. Access tokens stay on the server, encrypted — they are never shown here.</p>
          <div className="space-y-2 mb-4">
            {pages.map((p) => (
              <label key={p.pageId} className="flex items-start gap-2 border rounded p-3">
                <input
                  type="checkbox"
                  checked={selected.has(p.pageId)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(p.pageId); else next.delete(p.pageId);
                    setSelected(next);
                  }}
                />
                <span>
                  <span className="font-medium">{p.name}</span>
                  {p.category ? <span className="text-sm opacity-70"> · {p.category}</span> : null}
                  {p.instagram ? <span className="block text-sm opacity-70">Includes Instagram @{p.instagram.name}</span> : null}
                </span>
              </label>
            ))}
          </div>
          <button
            className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
            disabled={!selected.size || state === "connecting"}
            onClick={() => void connect()}
          >
            {state === "connecting" ? "Connecting…" : `Connect ${selected.size} Page${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
      {state === "done" && (
        <div>
          <p className="mb-2">Connected:</p>
          <ul className="list-disc ml-5 mb-4">
            {connected.map((c, i) => <li key={i}>{c.displayName} ({c.platform})</li>)}
          </ul>
          <a className="underline" href="/">Back to MetaOps</a>
        </div>
      )}
    </div>
  );
}
