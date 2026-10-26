# MetaOps AI

**An autonomous business operator for the Meta ecosystem.**
Built for the Meta Global AI Developer Hackathon — Startup Track. Founder: Femi Jekayinfa, FounderFlo LLC. Theme: *Push the Frontier.*

A business owner says: *"Run today's Meta business operations. Handle new customer inquiries, identify interested buyers, prepare tomorrow's promotion, and show me proof of what was completed."* MetaOps AI turns that into a structured, permissioned workflow: it retrieves inquiries from connected Facebook / Instagram / Messenger / WhatsApp Business accounts, classifies them, drafts grounded replies, gets explicit owner approval for every external action, executes through official Meta APIs (or a clearly labelled sandbox adapter), verifies results by reading platform state back, and produces a tamper-evident activity receipt.

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

- Secure auth (scrypt password hashing, signed session tokens), per-user business isolation.
- Business knowledge base + product catalog (incl. CSV import) grounding every draft; unknown facts are flagged for review, never invented.
- Connection layer with capability discovery: every account shows what it can and cannot do, with reasons (e.g. missing Graph permission).
- Live Graph API adapter (Facebook Pages, Instagram, Messenger, WhatsApp Cloud API) with tokens encrypted at rest (AES-256-GCM) and never exposed to clients; sandbox adapter with synthetic Harbor Goods data, always labelled.
- Unified inbox, lead management (AI priority is a *suggestion with explanation*, not verified intent), content studio, approval queue bound to exact payload hashes (edits invalidate the old approval), stateful task engine with checkpoints, idempotency keys, safe retries, recovery, SSE live updates, and SHA-256 activity receipts.

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
