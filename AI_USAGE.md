# MetaOps AI — Meta Model API Usage: Verification, Cost Model, Efficiency

**Date:** 2026-10-26 (America/Chicago) · **Scope:** Priority Five of the Final Engineering Directive (§7): verify the Meta Model API integration against current official documentation, model the per-run call/token/cost profile from recorded evidence, and make only provably safe efficiency reductions. **Client under review:** `apps/server/src/services/ai.ts` (the only module that talks to the Model API) and its engine call sites. Receipt/security/session code was out of scope and untouched.

**Method:** (1) Meta's official Model API documentation read live (sources in §10); (2) the repo's own `ai_calls` log in `data/metaops.db`, which records every live call's purpose, model, and token counts; (3) a bounded set of live probe calls against the configured key (10 generation calls + 1 model list + 1 deliberate error, ≈ **$0.08 total**, logged in §10). Meta's pricing page itself (dev.meta.ai) could not be fetched directly from this VM — the developer console is account-checkpointed and its billing pages are unreachable here — so pricing is stated as *re-verified by corroboration*: multiple current secondary sources quoting Meta's pricing page agree exactly with the rates this repo verified on dev.meta.ai on 2026-10-25 and uses in `approxCostUsd`.

---

## 1. Model identifiers — VERIFIED

| Client constant | Value | Evidence |
|---|---|---|
| `PRIMARY_MODEL` | `muse-wonder-1.0` | Live `GET /models` with the configured key (2026-10-26 probe) returned 200 with 9 model IDs, including `muse-wonder-1.0`. 300+ successful live generation calls on this ID are in `ai_calls` (Gate A + later runs). Secondary sources quoting Meta's model documentation list Muse Wonder as "Model ID muse-wonder-1.0, marked in preview", API-accessible (the stronger Wonder Full is Muse-Code-only and is **not** used). |
| `ALT_MODEL` | `muse-spark-1.3` | Same live `/models` listing includes `muse-spark-1.3` (alongside 1.2, 1.1, and the `-contributor` variants). 102 successful live classify calls on this ID are in `ai_calls`. The client uses the **Standard** ID — never a `-contributor` ID (Contributor trades training rights on prompts/completions for price; see §6). |

Both are the correct current public identifiers; no rename or version bump is indicated. Model IDs remain overridable via `METAOPS_MODEL` / `METAOPS_MODEL_ALT`.

## 2. Endpoint and request schema — CONFORMANT

Client (`metaJson`): `POST https://api.meta.ai/v1/responses`, `Authorization: Bearer <key>`, JSON body `{ model, input: [ { role: "system", content: [{ type: "input_text", text }] }, { role: "user", content: [{ type: "input_text", text }] } ] }` (plus, after this pass, the two cache fields in §8).

Official Responses API documentation (ai.developer.meta.com, "Responses API", read 2026-10-26):

- "Call `POST /v1/responses` with a `model` and `input`." ✓
- Input arrays carry typed items: "Messages with a `role` (`developer`, `system`, `user`, or `assistant`) and typed content blocks such as `input_text`, `input_image`, `input_file`…" — the client's system/user `input_text` items conform. A `system` role message is documented as applied at the same level as `developer`; the alternative top-level `instructions` field is equivalent ("Use whichever fits your code, you do not need both"), so the client's system-message approach is conformant, not a deviation.
- The client sets no sampling parameters. The docs note Muse models are tuned for the defaults (`temperature=1.0`, `top_p=1.0`) and advise leaving both unset. ✓ (Deliberate non-use, now documented.)
- The client does not use `previous_response_id`, tools, search grounding, or file inputs. All are optional; single-shot calls are a documented use of the endpoint. Not using server-managed history is also what keeps every call independently auditable.

## 3. Response schema and parsing — CONFORMANT (verified live)

The client extracts text from `output[]` items of `type: "message"`, concatenating their content blocks of `type: "output_text"`, then extracts the first JSON object and validates it (Zod schemas / `validatePlan`) before anything is used.

Live probe responses (2026-10-26) confirm the real shape: `output` = `[{ type: "reasoning", id: "rs_…", … }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "…" }] }]`. The client's filter correctly skips the `reasoning` item and reads the message text; all probe calls returned parseable JSON through exactly this path. The docs confirm chain-of-thought is surfaced as `reasoning` items in `output` and that response objects echo a full `usage` breakdown.

## 4. Usage fields — PARTIALLY CAPTURED (known, bounded gap)

Real `usage` object (live probe, verbatim shape):

```json
{ "input_tokens": 1753, "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens": 236, "output_tokens_details": { "reasoning_tokens": 207 },
  "total_tokens": 1989 }
```

The docs name the same fields (`input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`). The client records only `input_tokens` / `output_tokens` into `ai_calls` and **discards the two detail fields**. Consequences, both known before this pass and unchanged by it:

- `approxCostUsd` prices all input at the full rate, so reported costs are **upper bounds** now that prompt caching engages (§8). Splitting cached tokens into the receipt requires an `ai_calls.cached_tokens` column plus a receipt change — receipt.ts/store.ts belong to other priorities; recommended follow-up in §11.
- Reasoning tokens are invisible in reporting even though they dominate some purposes (§7). They are billed as output tokens; nothing is under-counted, just not broken out.

## 5. Error shapes — CONFORMANT with what the client relies on

The client relies on exactly two things: the HTTP status, and the raw body (it throws `meta_api_<status>: <first 200 chars>`). It never parses provider error JSON, so it cannot be broken by error-schema drift. Observed shapes:

| Case | Source | Shape |
|---|---|---|
| 402 billing | Recorded live 2026-10-26 (BUILD_STATUS) | `error.code = "billing_not_configured"`, message "To use this API key, your team needs to resolve a billing issue first" |
| 404 unknown model | Live probe 2026-10-26 | `{"error":{"code":"model_not_found","message":"The requested model was not found.","param":null,"type":"invalid_request_error"}}` |
| 500 transient | Live probe 2026-10-26 (1 of 11 calls; the identical retry succeeded) | `{"error":{"code":null,"message":"internal server error","param":null,"type":"server_error"}}` |
| 400 validation | Official Responses doc | `invalid_request_error` with a `param` field (e.g. `"input"`, `"include"`, `"call_id"`); also documents 413 `payload_too_large` and 504 `gateway_timeout` for over-long non-streaming requests |

All fit the envelope `{ error: { code, message, param, type } }`. Retry behavior (updated 2026-10-27, commit 9096010): live probing showed the Model API intermittently returns an empty model catalog or a 404 `model_not_found` in clusters, from networks where the same key otherwise works. `verifyModelApi()` now retries an empty/incomplete catalog, a 5xx, or a network error up to 4 attempts with backoff (401/403 still fail fast), and `metaJson` retries a 404 `model_not_found` or a 5xx up to 3 attempts. Other 4xx fail fast, including 402 and 429 (429 handling remains a separate open item); recovery beyond that happens one level up via the task engine's step retry/checkpointing. (BUILD_STATUS's phrase "Responses API, strict JSON schema, retries, usage capture" overstates two of these; see §7 notes N1/N2.)

## 6. Pricing — RE-VERIFIED BY CORROBORATION

Per 1M tokens, Standard tier (the only tier this client uses):

| Model | Input | Cached input | Output |
|---|---|---|---|
| `muse-wonder-1.0` | $4.00 | $0.20 | $20.00 |
| `muse-spark-1.3` | $1.25 | $0.15 | $4.25 |

These match the constants in `approxCostUsd` exactly. No long-context premium applies at the 1,048,576-token window. Contributor IDs (`muse-spark-1.3-contributor`, $0.10/$0.002/$0.20) are **never** used: that tier grants Meta training rights over prompts and completions, which for customer-message data is a data-governance decision, not a discount (repo standing rule, reaffirmed).

## 7. Per-run call / token / cost model (from recorded evidence, not estimates)

Live averages per call from `ai_calls` (all live rows: 102 classify, 102 draft_reply, 104 audit, 2 draft_content, 3 plan):

| Purpose | Model | Calls per conversation | Avg input | Avg output | of which reasoning* |
|---|---|---|---|---|---|
| plan | Wonder | once per task | 229 | 1,869 | — |
| classify | Spark | 1 | 337 | 1,094 | ~880 (81%) |
| draft_reply | Wonder | 1 | 1,846 | 574 | ~most of output |
| audit | Wonder | 1 (+1 per self-correction) | 2,069 | 741 | ~most of output |
| draft_content | Wonder | 2 per task (FB + IG) | 1,541 | 1,296 | — |

*Reasoning share measured in the 2026-10-26 probe (classify: 947/1,000 and 718/765 output tokens were `reasoning_tokens`); the log doesn't split it historically (§4).

**Gate A run reconstruction** (34 conversations, 2 content drafts): 1 plan + 34 classify + 34 draft + 36 audit + 2 content = **107 calls**; recorded totals 151,920 in / 88,812 out ≈ **$1.75** list. Rebuilding the cost from the per-purpose averages reproduces $1.77 — the model and the recorded run agree. Cost split:

| Component | Cost | Share |
|---|---|---|
| Wonder output (draft + audit + plan + content) | ≈ $1.03 | 58% |
| Wonder input (the repeated business-facts block dominates) | ≈ $0.56 | 32% |
| Spark output (mostly reasoning tokens) | ≈ $0.16 | 9% |
| Spark input | ≈ $0.01 | 1% |

**Formula** for a run with N conversations, C content drafts, R first-audit failures:
calls = 1 + N·(classify) + N·(draft) + (N + C + R)·(audit) + C·(content); each first-audit failure adds exactly **one** audit call (the correction itself, `correctDraft`, is deterministic — no model call — in both modes). A second audit failure fails closed; nothing reaches approvals.

**What dominates:** (1) Wonder *output* tokens (reasoning-inclusive) at $20/M; (2) the full `BusinessContext` JSON — all products, FAQs, policies — re-sent on **every** draft and **every** audit call (~1.4–1.7K tokens of the ~1.8–2.1K input). That repeated static block is the cacheable prefix §8 addresses. Per-conversation marginal cost at Gate A shape ≈ **$0.051**; fixed per-task overhead (plan + 2 content + their audits) ≈ $0.11.

Notes / contradictions with other repo docs found during this pass:

- **N1.** BUILD_STATUS describes the client as using "strict JSON schema". It does not send `text.format` (the Responses API's structured-output mechanism per the docs' OpenAI-compatibility notes). It prompts for JSON-only output, regex-extracts the first JSON object, and validates client-side with Zod. That is a legitimate, working design — Gate A ran on it — but the doc phrase should be corrected to "prompted JSON + client-side schema validation".
- **N2.** Same sentence claims "retries": at the time of that audit `metaJson` had none (see §5). Bounded client retries for transient empty-catalog / `model_not_found` / 5xx responses were added 2026-10-27 (commit 9096010, §5); engine step-layer retry also exists.
- **N3.** The `correctDraft` docstring in ai.ts says "Live mode: the engine re-drafts via the planner with the violations attached". The engine actually calls the deterministic `correctDraft` in both modes; no live re-draft call exists. The Gate A run needed zero corrections (36 audits = 36 drafts), so this path is untested live either way — flagging the docstring, not changing behavior, in this pass.

## 8. Efficiency change made (the only one): prompt-cache engagement

**Change** (`apps/server/src/services/ai.ts`, `metaJson`): every request now carries

```json
"prompt_cache_key": "metaops-<purpose>",
"prompt_cache_retention": "24h"
```

Both are documented Responses API fields (the docs: "Prompt cache retention: Set `prompt_cache_retention` to `"in_memory"` or `"24h"` as a hint for the server's prompt cache"; the key is the documented routing aid for cache hits). Neither field alters model-visible content or the output contract. The client's prompts were already static-prefix-first (system → business facts → per-message data); what was missing was the key.

**Live probe evidence** (identical ~1.15–1.75K-token static prefixes, back-to-back repeats, 2026-10-26):

| Call | Key sent? | Status | `cached_tokens` / input |
|---|---|---|---|
| W1 draft (cold) | no | 200 | 0 / 1,753 |
| W2 draft (repeat prefix) | no | 200 | **0** / 1,755 |
| W3 draft + key + retention | yes | 500 (transient `server_error`; see §5) | — |
| W4 draft + key + retention (repeat) | yes | 200 | **1,652 / 1,755 (94%)** |
| W5 fresh key + retention (cold) | yes | 200 | 0 / 1,150 |
| W6 fresh key + retention (repeat) | yes | 200 | **1,140 / 1,150 (99%)** |
| W7 key only (cold) | yes | 200 | 0 / 1,150 |
| W8 key only (repeat) | yes | 200 | **1,140 / 1,150 (99%)** |
| S1/S2 Spark classify pair | no | 200 | 0 / 298 (prefix likely below the cacheable minimum; untested with key) |

Without a key, an immediate identical-prefix repeat was served **0 cached tokens**; with a stable key, repeats are served **94–99% cached**. The single 500 (W3) did not recur on any other keyed call (W5/W7 first-use-of-key calls returned 200), so it is recorded as a transient, not an effect of the parameters.

**Expected effect** on a Gate A-shaped run: within each purpose sequence (34 drafts, 36 audits), every call after the first can serve its ~1.5K-token facts prefix at the cached rate ($0.20/M vs $4.00/M on Wonder) ≈ **$0.35–0.45 saved per run (~20–25% of the run's AI cost)**, plus lower latency on cached prefixes. Cross-run, the `24h` retention hint gives the prefix a chance to survive between operator runs for the same business (a hint, not a guarantee — stated as such). This is an expectation from probe measurements, not a measured production saving; the first live run after this change will show it directly in `usage` (though §4's logging gap means receipts still report the upper bound).

**Coverage:** `tests/ai-client.test.ts` (7 tests, stubbed fetch — no network) pins the endpoint, models per purpose, typed input items, facts-before-message ordering, the cache key/retention fields per purpose, output parsing across reasoning items, the 402 error path, and the `approxCostUsd` rate constants. Full suite: **86/86 pass**; `npm run build` green.

## 9. Reductions considered and NOT taken (with reasons)

| Candidate | Verdict | Reason |
|---|---|---|
| Lower `reasoning.effort` for classify (Spark output is ~81% reasoning tokens) | **Not taken** | The docs confirm `reasoning.effort` exists (`none` unsupported on Spark; `minimal…xhigh` accepted), but effort is a behavior knob: Gate A's classification/audit quality evidence was produced at the default. Changing it without a labeled quality eval would trade an unmeasured quality risk for ~$0.10/run. Correct next step is an eval, not a config flip. |
| Trim the business-facts block per call (only "relevant" products) | **Not taken** | The auditor's grounding guarantee depends on checking drafts against the *complete* fact set; a relevance filter can silently remove the fact that proves a draft wrong. Weakens the audit boundary — explicitly out of bounds for this pass. §8's caching attacks the same cost without touching content. |
| Merge classify into draft (one call) | **Not taken** | Classification feeds lead routing independently of drafts, and merging would change output semantics of both steps. Not a provably duplicate call. |
| `previous_response_id` chaining | **Not taken** | Server-managed history is for multi-turn conversations; these are independent single-shot calls. Chaining would couple calls and complicate the audit trail for no token saving (history is re-billed as input). |
| Batch / async endpoints | **Not available** | No batch pricing or endpoint for these models appears in the official docs or secondary coverage; nothing to adopt. |

**Conclusion:** apart from §8, no provably redundant call exists in the current design — every call in the per-conversation path (classify → draft → audit) does distinct work, step-level queries already skip completed work on resume (`category IS NULL` / `suggested_reply IS NULL`), and the plan call is once per task. The negative result is the evidence-based one for call *count*; the win available was in how repeated prefixes are *billed*, and that is §8.

## 10. Live probe log (2026-10-26, this pass)

All against the configured key; total ≈ $0.08, no billing or key changes; the demo server on port 8891 was not touched.

| # | Call | Model | Result |
|---|---|---|---|
| 1 | `GET /models` | — | 200; 9 IDs incl. `muse-wonder-1.0`, `muse-spark-1.3` |
| 2–5 | Draft-shaped probes W1–W4 | `muse-wonder-1.0` | §8 table (W3: one transient 500) |
| 6–9 | Cache attribution probes W5–W8 | `muse-wonder-1.0` | §8 table |
| 10–11 | Classify-shaped pair S1–S2 | `muse-spark-1.3` | 200s; correct JSON; output 1,000/765 tokens, reasoning 947/718 |
| 12 | Deliberate bad model | `muse-wonder-9.9-nonexistent` | 404 `model_not_found` (§5) |

## 11. Recommended follow-ups (for their owning priorities)

1. Add `cached_tokens` (and optionally `reasoning_tokens`) columns to `ai_calls` and split them in the receipt cost line, so reported cost stops being an upper bound (store.ts + receipt.ts — Priorities Three/six territory).
2. Run a labeled classification eval before touching `reasoning.effort` anywhere; if `minimal`/`low` holds accuracy on the seed corpus, classify is the cheapest remaining lever (~9% of run cost) — and the same question applies, with more money at stake, to the auditor's default effort (58% of run cost is Wonder output).
3. Correct the two BUILD_STATUS phrases flagged in N1/N2 and the `correctDraft` docstring in N3 when those docs are next edited.

## Sources

- Meta Model API documentation, "Responses API" — https://ai.developer.meta.com/docs/features/responses (official; read live 2026-10-26): endpoint, input item types, instructions equivalence, usage detail fields, `reasoning.effort` values, `prompt_cache_retention`, `max_output_tokens`, error shapes (400/413/504), structured output via `text.format`.
- Live API evidence from this repo: `GET /models` listing and 300+ recorded generation calls (`ai_calls`, `data/metaops.db`); the recorded 402 `billing_not_configured` body (BUILD_STATUS, 2026-10-26); the §10 probe.
- Pricing: rates as verified on dev.meta.ai 2026-10-25 (recorded in `approxCostUsd` comments and TECHNICAL_ACCEPTANCE.md), re-corroborated 2026-10-26 against multiple current secondary sources quoting Meta's pricing page (VentureBeat launch coverage; promptfoo and LiteLLM provider docs; Muse pricing trackers) — all agree on $4.00/$0.20/$20.00 (Wonder) and $1.25/$0.15/$4.25 (Spark 1.3 Standard). Meta's own pricing page was not directly fetchable from this VM in this pass; if exact-page evidence is required, that is a founder-browser task, not a code blocker.
