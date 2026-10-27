import { useState } from "react";
import { api, setToken } from "../lib/api";
import { btnPrimary, inputCls, labelCls, ErrorBox } from "../components/ui";

export default function Auth({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await api.post<{ token: string; userId: string }>(`/api/auth/${mode}`, { email, password });
      setToken(res.token);
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 text-center">
        <img src="/logo-512.png" alt="FounderFlo Ops" className="mx-auto mb-3 h-14 w-14 rounded-2xl object-cover" />
        <h1 className="text-2xl font-black tracking-tight">FounderFlo Ops</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          The autonomous business operator for your Facebook, Instagram, Messenger and WhatsApp Business accounts.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <label className={labelCls} htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
        </div>
        <div>
          <label className={labelCls} htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </div>
        {error && <ErrorBox message={error} />}
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>
          {busy ? "Working..." : mode === "register" ? "Create account" : "Sign in"}
        </button>
        <button type="button" className="w-full text-center text-sm font-semibold text-sky-700 dark:text-sky-300"
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
          {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-400">
        Meta platform tokens are stored encrypted on the server and are never sent to your browser.
      </p>
    </div>
  );
}
