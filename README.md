# FounderFlo Ops

**Developed by FounderFlo LLC.** FounderFlo Ops was built under the internal working name **MetaOps AI**; that name is retained in code, package names, and environment variables (for example `METAOPS_SECRET`) and in dated historical notes. The product is the same.

**An autonomous business operator for the Meta ecosystem.**
Built for the Meta Global AI Developer Hackathon — Startup Track. Founder: Femi Jekayinfa, FounderFlo LLC. Theme: *Push the Frontier.*

A business owner says: *"Run today's Meta business operations. Handle new customer inquiries, identify interested buyers, prepare tomorrow's promotion, and show me proof of what was completed."* MetaOps AI turns that into a structured, permissioned workflow: it retrieves inquiries from connected Facebook / Instagram / Messenger / WhatsApp Business accounts, classifies them, drafts grounded replies, gets explicit owner approval for every external action, executes through a platform adapter, and produces an activity receipt for everything it did.

Two adapters exist, and their status is different — stated plainly: the **Graph API adapter** (Meta's official APIs) is implemented and stub-tested, but **no live platform workflow has ever run** — a Meta developer-account confirmation checkpoint blocks the first real Page connection, and clearing it is a founder action. Every run to date has used the clearly labelled **sandbox adapter** on the platform side. Verification is per-platform and never upgraded beyond the evidence: where the platform supports reading the object back (Facebook/Instagram publishing, Messenger/Instagram messages), confirmation requires that read-back; WhatsApp exposes no message read-back endpoint, so WhatsApp actions top out at *provider-ID-returned*; an attempt whose outcome is ambiguous stays *unverified* by design rather than being resent or assumed.

MetaOps AI is a standalone application. It shares no code, credentials, or infrastructure with any other product.

## Quick start

```bash
npm install
cp .env.example .env        # set METAOPS_SECRET; add MODEL_API_KEY for live Muse Wonder planning/classification/drafting
npm run build
npm run dev:server          # API on http://localhost:8790
npm run dev:web             # PWA on http://localhost:5173 (proxies /api)
```

Then in the app: register → **Load Harbor Goods demo** (synthetic business, sandbox connections) → open **AI Operator** and run the hero objective → approve sends/publishes in **Approvals** → inspect the receipt in **Activity & Proof**.

Without `MODEL_API_KEY`, the app runs in an explicitly labelled demo mode: a deterministic planner/classifier/drafter (`demo-heuristic-v1 (not Meta AI)`) drives the sandbox workflow so the full loop can be demonstrated. Receipts record exactly which model handled each operation — demo mode is never presented as Meta AI.

## What works

- Secure auth (scrypt password hashing; HMAC-signed session tokens registered server-side — revocable, 8-hour TTL; production boot fails closed on a missing/default/short `METAOPS_SECRET`), per-user business isolation.
- Business knowledge base + product catalog (incl. CSV import) grounding every draft; unknown facts are flagged for review, never invented.
- Connection layer with capability discovery: every account shows what it can and cannot do, with reasons (e.g. missing Graph permission).
- Graph API adapter (Facebook Pages, Instagram, Messenger, WhatsApp Cloud API) — implemented against the documented endpoints and covered by stubbed-transport tests; **not yet run against a live Meta account** (developer-account checkpoint; WhatsApp was never added to the developer app — it requires a business portfolio that does not exist yet). Tokens encrypted at rest (AES-256-GCM) and never exposed to clients; sandbox adapter with synthetic Harbor Goods data, always labelled.
- Unified inbox, lead management (AI priority is a *suggestion with explanation*, not verified intent), content studio, approval queue bound to exact payload hashes (edits invalidate the old approval), stateful task engine with checkpoints, idempotency keys, safe retries, recovery, SSE live updates, and activity receipts. A receipt's SHA-256 checksum detects modification of the receipt relative to a trusted reference value of the hash; it is **not** a digital signature, proves nothing about who authored the receipt, and receipts are not cryptographically signed.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and the Meta integration
- [SECURITY.md](SECURITY.md) — threat model, approval/idempotency design, limitations
- [DEMO.md](DEMO.md) — exact demo script and fallback plan
- [SUBMISSION.md](SUBMISSION.md) — competition summary
- [LICENSES.md](LICENSES.md) — dependency & license inventory

## Tests

```bash
npm test
```

Vitest suites cover auth/isolation, token encryption, capability honesty, plan validation, prompt-injection resistance, grounded drafting, the full hero workflow (sandbox), rejection/edit approval flows, idempotency, CSV import, and receipt integrity.

Current status (as of Oct 26, 2026): **103/103 tests passing across 11 files**; `tsc --noEmit` clean in all three workspaces (shared, server, web); build green.
