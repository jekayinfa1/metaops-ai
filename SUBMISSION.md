# MetaOps AI — Submission summary

**Problem.** Small businesses run sales and support across Facebook, Instagram, Messenger, and WhatsApp, but the work is manual, scattered, and easy to get wrong: missed inquiries, inconsistent answers, no record of what was sent or why.

**What MetaOps AI does.** It is an autonomous business operator for the Meta ecosystem. From one natural-language objective it plans a permissioned workflow, retrieves and classifies customer inquiries, drafts replies grounded strictly in the business's own catalog and policies, creates lead records, drafts promotional content, and — only after explicit owner approval bound to the exact payload — sends and publishes through official Meta APIs. Every outcome is verified by reading platform state back, and the owner gets a tamper-evident activity receipt.

**How Meta AI powers it.** Muse Wonder (Meta Model API, Responses API) produces structured, schema-validated plans and drafts; Muse Spark handles lower-cost classification. Model output is treated strictly as proposals: a server-side allowlist, grounded knowledge base, and human approval gate decide what may execute.

**Key innovations.**
- Approval bound to payload hashes — an approval can never be reused for edited content.
- Idempotent execution + read-back verification that separates *confirmed* from *accepted* from *unverified*.
- Prompt-injection containment for untrusted customer text, demonstrated live in the demo data.
- Capability discovery that shows, per account, exactly which operations Meta permissions allow — and why not, when they don't.
- An honest demo architecture: a fully functional sandbox adapter and a clearly labelled deterministic fallback planner, so nothing in the demo is faked — sandbox activity and non-AI planning are identified as such in the UI and in receipts.

**Built new for this hackathon.** The entire codebase (API server, PWA, adapters, engine, tests) was written from scratch for MetaOps AI; no existing product code is used.

**Limitations.** Live Graph API use requires Meta app review/permissions per capability; Instagram publishing requires media; messaging windows and opt-in rules apply and are respected, not bypassed. Local persistence is SQLite (Postgres-compatible schema) for the hackathon build.

**Theme.** *Push the Frontier:* from chatbots that merely answer, to a supervised operator that plans, asks, acts, verifies, and proves its work.
