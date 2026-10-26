# MetaOps AI — Test Audit: Real Behavior vs Simulated Layers

**Date:** 2026-10-25 · **Suite:** 21 tests in `tests/metaops.test.ts` (14) and `tests/phase3.test.ts` (7), all passing (137s full run).

## How to read this audit

Every test runs the **real** Fastify application (via `app.inject`), the **real** SQLite database, **real** scrypt/HMAC auth, the **real** task engine, **real** SHA-256 payload hashing, and **real** AES-256-GCM token encryption. Two layers are deliberately simulated, and every test that touches them is marked:

- **[SANDBOX-PLATFORM]** — the platform side (Facebook/IG/Messenger/WhatsApp) is the labelled SandboxAdapter, not Meta's Graph API. It behaves like a platform (accepts sends, returns IDs, supports read-back) but proves nothing about real Meta connectivity.
- **[HEURISTIC-AI]** — the AI side is the deterministic `demo-heuristic-v1` stand-in, not Meta AI. It proves the *policy machinery* (grounding rules, approval binding, audit checks) but nothing about Muse model quality or API behavior.

No test makes a real network call to Meta. That is the audit's central finding: **the suite proves the application's internal correctness exhaustively and its external integrations not at all.**

## Per-test classification

| # | Test | Real behavior exercised | Simulated layer |
|---|---|---|---|
| 1 | rejects bad credentials and unauthenticated access | Real scrypt verify, token auth, 401 paths | — |
| 2 | hides other users' businesses | Real per-user isolation queries (404s) | — |
| 3 | sandbox connections expose honest capabilities | Real capability-reporting logic (insights correctly unavailable) | [SANDBOX-PLATFORM] data |
| 4 | tokens encrypted at rest, never returned | Real AES-256-GCM encryption + API response shaping | — |
| 5 | live Graph adapter reports missing permissions as unavailable | Real capability-derivation logic from a permission set | Graph API itself **not called** — logic only |
| 6 | planner forces approval on external ops | Real Zod plan validation (`validatePlan`) | Plan source is a fixture, not a model |
| 7 | planner rejects non-allowlisted operations | Real allowlist validation | Fixture plan |
| 8 | prompt injection cannot change policy | Real classifier + drafter + (Phase 3) auditor pipeline end-to-end | [HEURISTIC-AI] + [SANDBOX-PLATFORM] |
| 9 | grounded drafting never invents prices | Real grounding/refusal logic | [HEURISTIC-AI] |
| 10 | hero workflow end-to-end | Real engine: sync → classify → draft → approve → send → read-back verify → leads → content → publish → receipt, incl. real receipt hashing | [SANDBOX-PLATFORM] + [HEURISTIC-AI] |
| 11 | rejected approval → nothing sends | Real approval state machine | [SANDBOX-PLATFORM] |
| 12 | edit invalidates approval, binds new hash | Real canonical SHA-256 payload hashing + invalidation flow | — |
| 13 | duplicate runs don't duplicate sends/leads | Real idempotency keys + unique constraints | [SANDBOX-PLATFORM] |
| 14 | CSV product import | Real CSV parsing + persistence | — |
| 15 | auditor catches hallucinated price/discount/free-shipping | Real auditor checks (exact-match against catalog/KB) | Auditor brain is [HEURISTIC-AI] in demo mode; the live Wonder auditor is **untested** |
| 16 | auditor passes a grounded draft | Real auditor | [HEURISTIC-AI] |
| 17 | auditor catches injection compliance | Real auditor injection detection | [HEURISTIC-AI] |
| 18 | out-of-window WhatsApp → template correction | Real window logic + correction + re-audit | [HEURISTIC-AI] |
| 19 | deep-seed hero run with audit evidence | Real engine over 54 conversations; real audit persistence; real receipt contents | [SANDBOX-PLATFORM] + [HEURISTIC-AI] |
| 20 | mutated payload not sent on old approval | Real execution-time hash re-verification (a genuine security property, fully real) | [SANDBOX-PLATFORM] transport |
| 21 | 429 sync failure retries without duplicates | Real retry/backoff + dedupe logic | Fault is **injected into the sandbox adapter** — proves engine recovery logic, not Graph rate-limit behavior |

## What the suite does NOT prove (explicit)

1. **No real Graph API call has ever been made** — not a read, not a send. The adapter's request shapes are code-reviewed against docs only.
2. **No real Meta Model API call has ever been made** — live planner/classifier/drafter/auditor paths are untested code. JSON-schema adherence of real Muse responses is a live risk (the code validates and fails closed, but failure rates are unknown).
3. **No browser/UI tests** — the PWA is build-verified and API-contract-tested only.
4. **No webhook behavior** — webhooks are not implemented.
5. **No load/concurrency evidence** beyond single-process correctness.

## Credential-free probes (added 2026-10-25, see TECHNICAL_ACCEPTANCE.md)

Two read-only probes run outside the suite to test the *real* network boundary without credentials: the Graph API's response to an invalid token (proves endpoint reachability + real error shape through the adapter's URL construction), and the Meta Model API's response without a key (proves reachability + auth behavior). Neither is, or may be described as, a successful integration.


## Addendum (2026-10-26): live-readiness tests (+10, suite now 31)

`tests/live-readiness.test.ts` exercises the new Meta callback surface. Classification: the HMAC-SHA256 signature verification, `signed_request` verification, handshake logic, ingestion, and dedupe are **real behavior** (real crypto, real DB). The payloads are locally fabricated to Meta's documented shapes and delivered via `app.inject`, so — like the rest of the suite — they prove the code, not a live connection to Meta. The `/api/ai/verify` test covers only the honest `not_configured` path; its authenticated path can only be exercised with a real key.

## Addendum — test-suite hardening (2026-10-26)

A full-suite rerun after the live Gate A work exposed four latent defects, all fixed and verified (31/31 on a fresh DB, 31/31 on rerun against the same DB, 31/31 on the shared dev DB):
1. **Live key leaked into tests.** The .env loader ran under vitest, so tests silently used the real Meta Model API (slow, non-deterministic, real spend). The loader now skips when VITEST is set; tests are hermetic again.
2. **Seed timestamps decayed.** Sandbox seed messages carried fixed calendar dates (2026-10-25); as real time passed, threads aged out of the 24h messaging window and the (correct) Auditor blocked them, failing the hero test. The sandbox adapter now rebases seed times to "now", preserving relative ages. Window compliance remains covered by phase3 tests with fabricated out-of-window threads.
3. **Test DB isolation ignored.** getDb() honored only METAOPS_DATA_DIR, so suites shared the dev database. METAOPS_DB (directory) is now honored with top precedence.
4. **Fixed test emails.** The main suite registered fixed addresses, so any rerun on a used database cascaded into 401s. Test identities are now run-unique (same pattern the live-readiness suite already used).
Note: earlier "all passing" results were real but state-dependent (fresh or accumulated databases masked 2–4). The suite is now deterministic regardless of database history.
