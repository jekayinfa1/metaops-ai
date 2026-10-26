# MetaOps AI — Technical Acceptance

**Date:** 2026-10-25 · **Environment:** local VM, Node v24.22.1, SQLite (Postgres-compatible schema) · **Suite:** `tests/metaops.test.ts`, 14 tests, **14/14 passing** · **Build:** `npm run build` clean (shared, server, web) · **Smoke:** built server over HTTP — health 200, PWA 200, auth register 200.

Categories: **1** verified vs real provider · **2** verified in sandbox · **3** implemented, unverified · **4** mocked/simulated · **5** blocked by external dependency · **6** not implemented.

| # | Capability (per directive §2) | Category | Evidence |
|---|---|---|---|
| 1 | Facebook Page connectivity | **3** (live) / **2** (sandbox) | GraphAdapter endpoints implemented per Graph v21.0 docs; sandbox connection verified. No real Page token exists to test with. |
| 2 | Instagram professional connectivity | **3** / **2** | Same adapter pattern; live publish additionally requires a media URL (implemented as an explicit error for text-only drafts). |
| 3 | Messenger integration | **3** / **2** | Send/read via Page adapter pattern; sandbox-verified. |
| 4 | WhatsApp Business integration | **3** / **2** | Cloud API send/read shapes implemented; sandbox-verified. Template-message workflow **6** (not built). |
| 5 | Muse Wonder planning + tool execution | **5** | Responses API client complete (strict schema, retries, usage). Blocked: `MODEL_API_KEY` not configured. Fallback planner is deterministic and labelled `demo-heuristic-v1 (not Meta AI)` in API, UI banner, and receipts. |
| 6 | Inquiry classification | **2** (heuristic) / **5** (Spark live) | 7 sandbox conversations classified to expected categories in tests, incl. complaint and injection cases. |
| 7 | Knowledge grounding | **2** | Test: shipping question with no shipping policy in KB → draft refuses and requests the policy; no invented facts produced. |
| 8 | Response drafting | **2** / **5** | Drafts generated for all synced inquiries in hero test; stored as drafts, never auto-sent. |
| 9 | Human approvals | **2** | Approve executes exactly the hashed payload; edit invalidates the prior approval and creates a new pending one; stale/foreign decisions rejected (403/409 in tests). |
| 10 | Authorized messaging + publishing | **2** | Hero test: 7 sends + 1 publish execute only after approval, each with a platform message/post ID in sandbox. Live: **3**. |
| 11 | Workflow recovery | **2** | Test kills a task mid-plan (simulated process death), resumes, completes with **zero duplicate external actions**; duplicate full runs also deduplicated by idempotency keys + unique constraint. |
| 12 | Independent verification | **2** | Every send/publish is read back from the (sandbox) platform before being marked verified; content stored `unverified` if read-back fails. |
| 13 | Activity receipts | **2** | Receipt lists actions, approvals (with payload hashes), models used (honestly labelled), usage, recoveries; SHA-256 integrity check detects tampering in tests. Downloadable JSON from the UI. |
| 14 | Mobile usability | **3** | Mobile-first PWA: bottom nav, responsive layouts, installable manifest + service worker; built and served. Not yet human-tested on a physical phone — flagged as a founder 10-minute check in DEMO.md follow-ups. |
| 15 | AuthN/AuthZ + data isolation | **2** | Cross-user access returns 404s in tests; tokens encrypted at rest; no token ever returned by the API (asserted in connection tests). |

## Acceptance conclusion

- **Sandbox acceptance: PASS.** The complete directive workflow — connect → sync → classify → ground → draft → approve → send → verify → leads → content → publish → receipt — is proven by automated tests plus a full hero-flow run, with safety properties (approval binding, idempotency, grounding refusal, injection containment) individually tested.
- **Live acceptance: NOT PASSED — blocked, not failed.** Zero capabilities are verified against real providers. The blockers are: (a) `MODEL_API_KEY` for Meta AI; (b) a Meta app + Page/IG/WhatsApp test assets + tokens for Graph verification. Both require founder accounts/actions. Until at least one live read **and** one live approved send succeed with read-back evidence, no claim of production integration may be made (see Gate A in BUSINESS_READINESS_SCORECARD.md).
- **Known gaps vs production:** no webhooks (pull sync), no WhatsApp template workflow, no billing, in-process task engine (no separate worker), no email verification/password reset. Each is listed with severity in BUILD_STATUS.md.


## Phase 3 verification loop (2026-10-25) — actual terminal evidence

- `tsc --noEmit` — server: **CLEAN**; web: **CLEAN**.
- `npm run build` — shared + server + web production build: **clean** (web bundle 291 kB JS / 31 kB CSS).
- Full test suite `vitest run` — **21/21 passed (2 files, 137s)**: the original 14 (auth isolation, approvals, idempotency, recovery, grounding refusal, injection, receipt tamper, hero workflow) plus 7 new Phase 3 tests:
  - Auditor unit: catches a hallucinated price ($9 vs $18 catalog), an unverified 50% discount, and a fake free-shipping claim in one draft; passes a grounded draft; catches compliance with an injection attempt (`injection_echo`); flags a 30h-old WhatsApp thread (`window_violation`) and verifies the template correction re-audits clean.
  - Deep-seed hero integration: full hero workflow over the 54-conversation dataset completes with audit evidence in the receipt (blocked + template-corrected + passed actions), the out-of-window conversation ends `sent_confirmed` as a template, and **zero** outbound messages comply with any injection attempt.
  - Payload mutation: a draft mutated in the database after approval is **not sent** on the old approval; exactly one fresh pending approval is created for the mutated payload; other approved replies send normally.
  - 429 recovery: a sandbox sync fault injected as `graph_error_429_rate_limit` is retried (sync step attempts = 2), the task completes, and conversation counts show **no duplicates** from the retry.
- Seed script run — `SEED VERIFICATION: PASS` (counts above).
- Production boot check — built server: `GET /health` → `{"ok":true,"service":"metaops-ai","aiConfigured":false}`; `GET /` → 200 (PWA served).

**Unchanged from the first acceptance:** live-provider verification remains **not passed** — no `MODEL_API_KEY`, no Meta app. The auditor's live Muse Wonder path is implemented but unexercised; its demo-mode deterministic path is what the tests above prove.

## Credential-free live probes (2026-10-25) — real network boundary, invalid credentials

Run via `scripts/probe.mts` through the real code paths (output captured verbatim):

- **Graph API through the real GraphAdapter** (bogus token encrypted with the app's own encryption, real HTTPS call to graph.facebook.com/v21.0): `graph_api_401: Invalid OAuth access token - Cannot parse access token (code 190)` — Meta's genuine OAuth error. Proves adapter URL construction, token decryption, request execution, and error surfacing. **Not a successful integration.**
- **Meta Model API** (POST https://api.meta.ai/v1/responses, no key): HTTP 401 `{"error":{"code":"invalid_api_key","type":"authentication_error"}}` — Meta's genuine auth response. Proves endpoint reachability and the expected failure mode. **Not a successful integration.**
- **.env loader verified:** a dummy key in `.env` flips `/health` to `aiConfigured: true` and `/api/ai/status` to the real model names; dummy `.env` deleted afterwards. No real key exists in this environment.

**Gate A status after probes: still NOT passed** — reachability and error shapes are verified; no authenticated call has ever succeeded.


## Live-readiness additions (2026-10-26)

- **Webhook surface built and tested** (10 new tests, `tests/live-readiness.test.ts`; full suite now 31): verification handshake (challenge echo / wrong-token 403), HMAC-SHA256 signature enforcement (forged events ingest nothing), Messenger + WhatsApp ingestion into matched live connections, redelivery dedupe by provider message ID, unknown-account events acknowledged without ingestion.
- **Data-deletion callback built and tested:** valid `signed_request` → data matched to the app-scoped user ID deleted, `{url, confirmation_code}` returned, status endpoint reports completion; bad signatures rejected.
- **Model API self-check built:** `POST /api/ai/verify` performs a real authenticated `GET /models` when a key exists and reports the outcome verbatim; without a key it returns `not_configured` (tested). `scripts/live-smoke.mts` runs Gate A checks A–D and reports BLOCKED (never PASS) when credentials are absent.
- **None of this changes Gate A:** the webhook/deletion tests use locally fabricated, validly-signed payloads through the real verification code — the crypto and ingestion are real, the transport is not Meta's. No authenticated Meta call of any kind has succeeded yet.

## Gate A — AI half PASSED (2026-10-26)

Live evidence (task 4e68adb2, Harbor Goods deep seed, platform = sandbox adapter): the full operator loop ran on REAL Muse models — Spark classification x34, Wonder planning x1, Wonder reply drafting x34, Wonder content drafting x2, Wonder independent audits x36 (all final verdicts ok) — followed by 61 approved sends and 2 approved publishes, all read-back `confirmed` in the receipt (97/97 actions), 21 leads, receipt SHA-256 9e8db62c…, total live usage 151,920 in / 88,812 out tokens (~$1.75 list, against the $150 hackathon credit). Capability #5 (Muse Wonder planning + tool execution) moves from category 5 (blocked) to **category 1 for the AI layer**; capabilities #1–4, #10 remain category 3 (live) / 2 (sandbox) — no real Meta platform asset has been connected yet, so **Gate A as a whole is still not passed**.
