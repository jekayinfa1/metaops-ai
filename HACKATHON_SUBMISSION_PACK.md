# MetaOps AI — Hackathon Submission Pack (DRAFT)

Status: draft prepared 2026-10-26 for the founder to review and submit personally. Nothing here has been submitted. Every number below is traceable to BUILD_STATUS.md / receipts in this repo.

## Project name
MetaOps AI

## Tagline
The autonomous business operator for the Meta ecosystem — with receipts.

## Short description (one paragraph)
MetaOps AI runs a small business's Meta inbox end to end: it reads Facebook, Instagram, and WhatsApp inquiries, classifies them, drafts replies grounded in the business's own catalog and policies, has every draft independently audited by a second model pass, sends only what the owner approves, and issues a verifiable receipt for everything it did. Automation tools ask for trust; MetaOps produces evidence.

## What it does
- Ingests Page/Instagram/WhatsApp conversations (Graph API + webhooks, signature-verified, deduplicated).
- Muse Spark classifies every inquiry (intent, urgency, lead signals); Muse Wonder plans the work and drafts replies and content.
- A dual-pass Auditor (independent Wonder pass) checks each draft for unsupported claims, policy violations, prompt injection, and messaging-window compliance — with self-correction, and WhatsApp template conversion for out-of-window sends.
- Owner approvals are bound to a SHA-256 payload hash: edit the payload and the approval is void.
- Every run ends in a receipt: actions taken, read-back confirmations, models used, token usage and cost, evidence hash.
- Production connect flow: Facebook Login OAuth → long-lived Page tokens → encrypted at rest, with debug_token health checks.

## How it uses Meta technology
- **Meta Model API:** Muse Wonder (planning, drafting, auditing) and Muse Spark (classification), called directly — verified live: 107 calls in one operator run, all four purposes, receipted.
- **Meta developer platform:** app "FounderFlo Ops" (ID 1671236714578648) with Messenger + Instagram use cases; webhook ingestion and the data-deletion callback implemented and tested; permissions/App Review path documented from Meta's official docs.
- Built for the Meta ecosystem's small businesses first (Instagram/Facebook retailers; WhatsApp-driven SMBs; agencies).

## Proof, not promises (as of 2026-10-26)
- Live operator run completed end-to-end on real Muse models: 34 classifications, 34 reply drafts, 2 content drafts, 36 audits (all final verdicts pass), 61 approved sends + 2 publishes, **97/97 receipt actions confirmed**, 21 leads identified.
- Total live cost of that run: ~$1.75 at list prices, drawn on the $150 hackathon credit.
- Test suite: 38 automated tests (operator workflow, auditor, approvals/idempotency/recovery, webhooks, data-deletion, OAuth connect flow).
- Commercial validation pack: competitor teardown (Manychat, WATI, SleekFlow, respond.io, Sprout, Meta Business Agent), pricing and unit economics ($29/$79 pilot tiers modeled at ~82–84% contribution margin), target-customer and validation plan. Recommendation so far: validate further — customer demand is NOT yet claimed as validated (zero customer conversations held at time of writing).

## Honest limitations
- The live run's platform side used a simulated (sandbox) storefront: our Meta developer account is in an account-confirmation checkpoint whose email codes Meta has not delivered, so a real-Page workflow is still pending. Gate A (our own acceptance bar: live AI **and** live platform) is half passed, and we say so.
- No App Review submission yet; Advanced Access, Business Verification, and the WhatsApp use case (needs a business portfolio) are post-hackathon steps, sequenced in the 30-day launch plan.
- This public repository is the curated hackathon mirror (code, tests, technical docs); the commercial validation and pricing workbooks remain private.

## Team
FounderFlo LLC (Femi Jekayinfa, solo founder) — enterprise software sales background (Microsoft, Dropbox, Box); built and operates MetaOps AI with an AI-assisted workflow. MetaOps AI is an independent product; it reuses nothing from the founder's other product (Floaty).

## Track
Startup Track — Meta Global AI Developer Hackathon.
