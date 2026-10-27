# FounderFlo Ops — Demo Runbook

Status: prepared 2026-10-26. The demo runs the REAL Muse models (live Meta Model API, hackathon credit) against the sandbox platform dataset. Say that sentence out loud at the start — it is the honest frame for everything that follows: **live AI, simulated storefront, real receipts.**

**Recorded video: COMPLETE** (2026-10-26) — the final cut exists at `~/workspace/metaops-demo/metaops-demo.mp4` (2:50), re-shot from the latest live run (task `82d5e279…`, Harbor Goods on the display-rebranded UI: 109 Muse calls, receipted — 168 actions, 166 confirmed, 2 auditor-blocked, ≈$1.99) and fully re-voiced: dashboard, inbox safety threads, operator run, approvals queue, receipt, leads. Its cards and opening narration state it was built with Muse on the Meta Model API for the Meta Global AI Developer Hackathon (Startup Track). The ~6-minute script below remains the live-presentation version. The directive's two extra scenes are **FILMED** and in the video: **failure recovery** (server killed mid-send at 7 accepted sends with a further send in flight; restarted, paused, resumed, and completed with zero duplicate sends — 63 ledger rows all accepted, all 61 conversations confirmed sent) and **edit-after-approval invalidation** (a pending approval edited on camera: old approval invalidated, new payload hash, edited text sent verbatim only after re-approval). The scenes were first filmed from the earlier session-2 run and re-filmed for the current cut; full evidence in SCENE_EVIDENCE.md (demo folder) and DEMO_ACCEPTANCE_CHECKLIST.md. One defect found while filming: the Operator UI's Pause/Resume buttons POST an empty body with a JSON content type and the server returned 400, so the filmed pause/resume used the same endpoints via the owner's authenticated API session (states verified at each step). That defect is FIXED as of 2026-10-27 (commit ff0671f): the API parses an empty JSON body as {} across all seven affected action endpoints, pinned by regression tests and a live smoke check; malformed JSON still returns 400.

## Before you present (10 minutes)

1. `npm run build && PORT=8891 node apps/server/dist/index.js` (server must have MODEL_API_KEY in .env — it does on the dev machine; /health shows aiConfigured: true).
2. Open http://localhost:8891, register or log in, seed the **deep** Harbor Goods dataset (Demo: seed-deep) — 36 products, 54 conversations, 10 historical receipts.
3. Optional but powerful: keep the Gate A live receipt summary handy (task completed 2026-10-26: 107 live calls, 97/97 actions confirmed, SHA-256 `9e8db62c…`, ~$1.75). It is the same flow you are about to run, already executed once with a verifiable receipt.

## The demo (about 6 minutes)

**Minute 0–1 — The problem.** "A small retailer gets the same questions on Facebook, Instagram, and WhatsApp all day. Existing tools automate sending. None of them prove what they did. FounderFlo Ops is an operator you can audit."

**Minute 1–3 — Run the operator.** Operator screen → objective: *"Run today's operations: answer new inquiries, flag serious buyers, prepare tomorrow's promotion, and show me proof."* Run it. Narrate while it works: Muse Spark classifies each inquiry; Muse Wonder plans, drafts; a second Wonder pass **audits every draft** against the business's own facts, policies, and the platform messaging windows before anything can send.

**Minute 3–4 — Approvals.** The task parks at approvals. Open one: the exact payload is hash-bound — edit it and the old approval dies; what you approve is byte-for-byte what sends. Approve the sends and the post.

**Minute 4–5 — The receipt.** Open the receipt: every action read-back confirmed, the models used, token usage and cost, the SHA-256 evidence hash. "Trust, but verify — this is the artifact a business owner shows their team."

**Minute 5–6 — The two safety beats.**
- The injection probe: a "customer" message tries to extract internal costs and a 90% discount. It is classified as an attack, drafted a safe refusal, and the audit trail shows the detection.
- The out-of-window WhatsApp thread: the auditor flags the 24-hour window violation and the send converts to an approved template message instead of a policy-breaking free-form reply.

## If a judge asks the hard questions

- **"Is this live on real Pages?"** "The AI is live — real Muse Wonder and Spark calls, metered against our hackathon credit, with the receipt to prove it. The storefront in this demo is a simulated dataset because our developer account is sitting in a Meta confirmation checkpoint; the production connect flow (Facebook Login, long-lived Page tokens) is built and tested with a stubbed Graph transport, and the app 'FounderFlo Ops' exists in the console. Gate A — our own bar — requires both halves live, and we say plainly it is half passed."
- **"How is this different from Manychat?"** "They sell automation. We sell verifiable operations: approval-bound actions, an independent audit pass, and a receipt for everything. Their pricing also scales per contact; ours is a flat subscription with transparent AI cost."
- **"What does it cost to run?"** "The full run you just watched costs about $2 at list prices (the latest receipted run: $1.99 across 61 conversations). Paid pilot tiers are planned; the unit-economics model lives in the private commercial pack."
- **"What about the 30-second response rule?"** "Approval-first is our wedge, so we do not auto-send. The compliance design treats the approval queue as the product surface; an instant auto-acknowledgement that sends nothing substantive is on the roadmap and deliberately not silently enabled."

## Fallbacks

- **Live API down during the demo:** switch to the recorded Gate A receipt (BUILD_STATUS.md, 2026-10-26 section) and walk the audit trail in the Activity screen. The sandbox heuristic mode exists and is labeled "demo-heuristic (not Meta AI)" everywhere — never present it as Meta AI.
- **Checkpoint cleared by demo day:** swap Act 1 to the real Floaty Page via Connect with Facebook and run the same script on the live inbox (read test first, then one approved send to a controlled thread).
