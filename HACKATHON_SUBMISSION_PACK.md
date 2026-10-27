# FounderFlo Ops — Hackathon Submission Pack (DRAFT)

Status: draft prepared 2026-10-26 for the founder to review and submit personally. Nothing here has been submitted. Every number below is traceable to the run receipts and TECHNICAL_ACCEPTANCE.md in this repo.

## Project name
FounderFlo Ops

## Tagline
The autonomous business operator for the Meta ecosystem — with receipts.

## Short description (one paragraph)
FounderFlo Ops runs a small business's Meta inbox end to end: it reads Facebook, Instagram, and WhatsApp inquiries, classifies them, drafts replies grounded in the business's own catalog and policies, has every draft independently audited by a second model pass, sends only what the owner approves, and issues a verifiable receipt for everything it did. Automation tools ask for trust; FounderFlo Ops produces evidence.

## What it does
- Ingests Page/Instagram/WhatsApp conversations: sandbox sync today; the Graph API + webhook path (signature-verified, deduplicated) is implemented and locally tested but has never been configured in a live app or received a real event.
- Muse Spark classifies every inquiry (intent, urgency, lead signals); Muse Wonder plans the work and drafts replies and content.
- A dual-pass Auditor (independent Wonder pass) checks each draft for unsupported claims, policy violations, prompt injection, and messaging-window compliance — with self-correction, and WhatsApp template conversion for out-of-window sends.
- Owner approvals are bound to a SHA-256 payload hash: edit the payload and the approval is void.
- Every run ends in a receipt: actions taken, per-action verification levels (never upgraded beyond the platform evidence — WhatsApp tops out at provider-ID-returned, since it has no read-back endpoint), models used, token usage and cost, and a SHA-256 checksum that detects modification relative to a trusted reference value (it is not a signature and proves no authorship; receipts are not cryptographically signed).
- Connect flow: Facebook Login OAuth → long-lived Page tokens → encrypted at rest, with debug_token health checks — completed against real Meta on 2026-10-27: the founder's Floaty Page is live-connected to the hosted deployment, and Meta's debug_token verifies the Page token as valid with all nine requested permissions granted.

## How it uses Meta technology
- **Meta Model API:** Muse Wonder (planning, drafting, auditing) and Muse Spark (classification), called directly — verified live across four full operator runs (107–109 calls each, receipted); the filmed run alone made 109 calls spanning all five purposes (plan, classify, draft, audit, content).
- **Meta developer platform:** app "FounderFlo Ops" (ID 1655331439545843, registered under the founder's original Facebook account) with Messenger + Instagram use cases; webhook ingestion and the data-deletion callback implemented and tested; permissions/App Review path documented from Meta's official docs.
- Built for the Meta ecosystem's small businesses first (Instagram/Facebook retailers; WhatsApp-driven SMBs; agencies).

## Proof, not promises (as of 2026-10-26)
- Live operator run completed end-to-end on real Muse models: 34 classifications, 34 reply drafts, 2 content drafts, 36 audits (all final verdicts pass), 61 approved sends + 2 publishes, **97/97 receipt actions confirmed**, 21 leads identified. A second, identical-shape live run (the demo run) also completed: 107 live calls, receipted.
- Total live cost per run: ~$1.75–$1.99 at list prices, drawn on the $150 hackathon credit.
- Demo video: a 2:50 recorded walkthrough (`~/workspace/metaops-demo/metaops-demo.mp4`) — live AI, sandbox storefront, real receipts; the title and closing cards and the opening narration state it was built with Muse on the Meta Model API for this hackathon. The filmed run (109 live calls, ≈$1.99, receipted: 168 receipt actions, 166 confirmed, 2 blocked — the auditor rerouting out-of-window WhatsApp drafts to approved templates) supplied the failure-recovery scene — server killed mid-send at 7 accepted sends with a further send in flight, then restarted and resumed to completion with zero duplicate sends (63 ledger rows, all accepted; all 61 conversations confirmed sent) — and the edit-after-approval invalidation scene (editing a pending approval invalidated it and created a new pending approval under a fresh payload hash; the edited text was sent verbatim only after re-approval).
- Test suite: **120 automated tests passing** (operator workflow, auditor, approvals/idempotency/recovery, Graph adapter, verification ladder, security hardening, webhooks, data-deletion, OAuth connect flow); typecheck clean in all three workspaces.
- Commercial validation pack: competitor teardown (Manychat, WATI, SleekFlow, respond.io, Sprout, Meta Business Agent), pricing and unit-economics analysis, target-customer and validation plan. Recommendation so far: validate further — customer demand is NOT yet claimed as validated. The entry was built zero to a proven, receipted product in 10 days, entirely with Muse; customer validation is the post-hackathon step sequenced in the 30-day launch plan.

## Honest limitations
- The filmed live runs' platform side used a simulated (sandbox) storefront, labelled as such. The platform half of our acceptance bar PASSED on 2026-10-27: the first Meta app we created sat under a Facebook account stuck in an account-confirmation checkpoint whose email codes Meta never delivered, so the submitted app (ID 1655331439545843) was registered under the founder's original account, and the founder's real Floaty Page was connected to the hosted deployment through it, with Meta's own token inspection confirming all nine permissions. Public availability (App Review for Advanced Access, Business Verification, webhook arming) remains post-hackathon; no post was published and no message was sent during the connection verification.
- No App Review submission yet; Advanced Access, Business Verification, and the WhatsApp use case (needs a business portfolio) are post-hackathon steps, sequenced in the 30-day launch plan.
- UI defect found while filming, FIXED 2026-10-27 (commit ff0671f): the Operator screen's Pause and Resume buttons POST an empty body with a JSON content type, which the server's default JSON parser rejected (400) — so in the filmed failure-recovery scene, pause and resume were issued through the owner's authenticated API session against the same endpoints, with the task state verified at each step. The API now parses an empty JSON body as {} on all seven affected action endpoints (task pause/resume/cancel, approval approve/reject, logout/logout-all), pinned by regression tests and a live smoke check; malformed JSON still returns 400.
- The GitHub repo (github.com/jekayinfa1/metaops-ai) is public and, as of Oct 27, 2026, carries the current security-reviewed build — a curated snapshot of this private working repo, refreshed the same day. Internal investigation tooling (the relay/ folder used to diagnose a transient Meta API catalog issue) is held back from the public snapshot; everything needed to run and verify the product is included.

## Team
FounderFlo LLC (Femi Jekayinfa, solo founder) — enterprise software sales background (Microsoft, Dropbox, Box); built and operates FounderFlo Ops with an AI-assisted workflow. FounderFlo Ops is an independent product; it reuses nothing from the founder's other product (Floaty).

## Track
Startup Track — Meta Global AI Developer Hackathon.
