# Architecture

## Overview

```
Phone / Web PWA (React + Vite + Tailwind)
        |  HTTPS + SSE (Bearer session token)
API server (Fastify + Zod)
        |-- Auth & businesses / knowledge base / catalog
        |-- Unified inbox, leads, content, approvals
        |-- AI Operations Engine (stateful task runner)
        |       |-- AI service -> Meta Model API (Muse Wonder / Spark)
        |       |-- Platform adapters (one per connection)
        |       |-- Verification (platform read-back)
        |       |-- Receipts (SHA-256 integrity)
        |-- Persistence (SQLite locally; PostgreSQL deployment target)
Platform adapters
        |-- GraphAdapter  -> Meta Graph API (Facebook, Instagram, Messenger, WhatsApp Cloud API)
        |-- SandboxAdapter -> isolated synthetic platform state (Harbor Goods)
```

## Key design decisions

1. **Model proposes, engine disposes.** Muse Wonder returns structured plans/classifications/drafts validated against Zod schemas and an operation allowlist (`list_eligible_messages`, `classify_conversations`, `draft_replies`, `send_approved_replies`, `identify_leads`, `create_content_drafts`, `publish_approved_content`, `generate_report`). No other operations exist. External operations are forced to `requiresApproval: true` server-side regardless of what a plan says.
2. **Approvals bind to payloads.** Each approval stores a canonical SHA-256 hash of the exact action payload. Editing creates a new pending approval and invalidates the old one; a stale approval cannot authorize different content.
3. **Idempotency everywhere.** Sends and publishes carry deterministic idempotency keys (`task:step:target`); adapters and the DB enforce uniqueness, so retries and duplicate runs cannot double-send.
4. **Verification is evidence-graded, never upgraded.** After a send/publish, the engine records the strongest evidence the platform actually supplies, on a fixed ladder: request attempted → provider accepted → provider ID returned → object confirmed → published (plus delivered/read where platform webhook receipts exist). Read-back is per-platform: Facebook/Instagram publishing and Messenger/Instagram messages can be confirmed by object fetch; **WhatsApp exposes no message read-back endpoint, so its ceiling is provider-ID-returned** absent webhook delivery evidence. An attempt with an ambiguous outcome (e.g. a timeout after the request may have landed) stays *unverified* and is never resent. The live Graph path is implemented and stub-tested; to date, verification has only been exercised against the sandbox adapter — no live platform workflow has run (developer-account checkpoint).
5. **Recovery with reconciliation.** Transient failures (timeouts, 429, 5xx) retry with backoff; after an ambiguous mutation outcome the engine reconciles against platform state before any retry. Non-transient errors fail the step fast and the task ends `partially_completed` rather than claiming success.
6. **Prompt-injection containment.** Customer text is passed to models explicitly as untrusted data with an instruction hierarchy; classifier output is constrained to an enum; the planner cannot mint new operations; drafting is grounded only in the business knowledge base.

## Persistence

Local development uses SQLite via Node's built-in `node:sqlite` driver — zero native dependencies and a one-command start, which matters for a 10-day hackathon. The schema is intentionally Postgres-compatible (JSON in TEXT columns, ISO timestamps); **deployment target is PostgreSQL** with the same tables. Redis-backed queues are unnecessary at this scale: the engine is a persisted, checkpointed in-process runner whose state survives restarts because every step transition is written to the database before execution continues.

## AI integration

- Endpoint: `POST https://api.meta.ai/v1/responses`, key from server env `MODEL_API_KEY` only.
- `muse-wonder-1.0` — planning and drafting. `muse-spark-1.3` — classification (lower cost).
- Every AI call is logged (purpose, model, tokens, latency) and surfaced in the receipt with an approximate cost.
- Demo mode: with no key configured, a deterministic heuristic implementation of the same interfaces drives the sandbox. It is labelled `demo-heuristic-v1 (not Meta AI)` in the API status, the UI banner, and every receipt.

## Platform adapters

| Platform | Live path (Graph API v21.0) | Sandbox |
|---|---|---|
| Facebook Page | `GET /{page}`, `/{page}/posts`, `POST /{page}/feed`, insights with `read_insights` | synthetic threads + posts |
| Instagram | profile/media, messaging with `instagram_manage_messages`, publishing needs a media URL (two-step container) — text-only drafts report this honestly | synthetic threads + posts |
| Messenger | `GET /{page}/conversations`, Send API `POST /me/messages` (24h window rules apply) | synthetic threads |
| WhatsApp | Cloud API `POST /{phone-number-id}/messages` (opt-in + window rules apply) | synthetic threads |

Capability discovery runs per connection: permissions recorded at connect time (and account checks) determine what the UI offers; anything unavailable shows the reason.
