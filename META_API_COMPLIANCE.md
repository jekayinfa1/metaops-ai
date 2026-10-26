# MetaOps AI — Meta Platform Requirements & Compliance Matrix

**Research date:** 2026-10-25/26 · **Sources:** Meta's official developer documentation (developers.facebook.com), read live during research; each section cites its doc. Secondary-sourced items are marked. This is an engineering compliance map, not legal advice.

## The one-paragraph version

Any app can use every permission immediately in **Standard Access** — but only for people with a role on the app (your own team/testing). Serving **third-party businesses** requires **Advanced Access**: a verified Meta Business (Business Verification has been required for Advanced Access since Feb 1, 2023) plus **per-permission App Review** for several permissions, a published privacy policy, a data-deletion mechanism, and an annual Data Use Checkup thereafter. MetaOps' pilot can therefore start today against the founder's own assets, and supervised-mode pilots can run before review completes — but self-serve onboarding of strangers is gated on Meta's approval, not on our code.

## Requirements checklist

| Requirement | What it means | Source |
|---|---|---|
| Developer account + app | Register as a Meta developer, create an app (App ID + App Secret). Use cases auto-add base permissions. Apps accessing data they don't own must connect to a **business portfolio** | developers.facebook.com/documentation/development/create-an-app |
| Business Verification | Required for Advanced Access since 2023-02-01: legal business documents (incorporation, license/tax, address proof) verified in Business Settings. Without it, permissions stay inactive for external businesses. **FounderFlo LLC note:** the LLC's Texas franchise-tax forfeiture must be reinstated first — a forfeited entity will not pass verification cleanly (see the separate FounderFlo reinstatement item). | …/development/release/business-verification |
| App Review | Per-permission review where required: Meta tests actual use; submission needs completed App Settings (icon, **privacy policy URL**, category, business email), per-permission use-case descriptions + screencasts, and (per secondary sources) ≥1 successful API call in the prior 30 days. Meta publishes **no timeline SLA** (third parties report 1–3 weeks — unverified). | …/resp-plat-initiatives/individual-processes/app-review |
| Data Use Checkup | Annual self-certification required for apps with Advanced Access | …/development/graph-api/overview/access-levels |
| Privacy policy | Public privacy policy URL is mandatory before App Review submission | App Review docs |
| Data deletion | Must offer a **data deletion callback** (Meta POSTs an HMAC-SHA256 `signed_request`; callback starts deletion and returns `{url, confirmation_code}`) or a deletion-instructions URL. Non-compliance risks enforcement | …/create-an-app/app-dashboard/data-deletion-callback |
| Webhooks | HTTPS endpoint with valid TLS; verification via GET `hub.mode=subscribe` / `hub.challenge` / `hub.verify_token` (echo the challenge); payloads arrive SHA256-signed in `X-Hub-Signature-256` with the App Secret; respond 200. The Webhooks product itself needs no App Review but respects permission access levels | developers.facebook.com/docs/graph-api/webhooks/getting-started |
| IG professional accounts | Instagram API access requires a **Business/Creator account linked to a Facebook Page** (confirmed via secondary guides; Meta's permissions reference implies it) — an onboarding step MetaOps must detect and guide | permissions reference + secondary guides |
| Messenger/IG messaging policy | Standard messaging window (24h, corroborated by secondary sources; opened by user actions). Outside it: only Message Tags, One-time Notification (not IG), Utility/Marketing Messages, Sponsored Messages (not IG). **Bots must respond to any user input within 30 seconds** — MetaOps' approval flow must therefore auto-acknowledge instantly even though the substantive reply awaits approval. Bot disclosure where law requires | …/business-messaging/messenger-platform/policy |
| WhatsApp Cloud API | `whatsapp_business_messaging` (+ `whatsapp_business_management`). **Opt-in required** before messaging a user. Non-template messages only inside the **24-hour customer service window**; outside it, **pre-approved template messages only** (auto-reviewed; must reach APPROVED status; unverified portfolios capped at 250 templates/account vs 6,000 verified) | …/business-messaging/whatsapp (templates overview, pricing) |

## WhatsApp pricing (per-message model, since Jul 1 2025)

Charged only on **delivered business→user messages**, by template category (Marketing / Utility / Authentication) or Service replies × recipient country. User→business messages are free. From **Oct 1, 2026**: service messages are charged after **1,000 free per number/month**; utility templates inside an open window are also charged. Click-to-WhatsApp entry conversations are free up to 7 days if the business responds within 24h. Rates are published **only as downloadable rate cards** (47 markets); secondary readers of the Oct 1 2026 card report, e.g., North America utility/auth/service **$0.0034**, marketing **$0.0250**; UK utility $0.0220; India utility $0.0014; Germany $0.0550; France $0.0300 — treat exact figures as **to-confirm from the official rate card** before billing customers. Meta Business Agent messages are priced separately at **$2.00 per 1M tokens**.

## Permissions & approval matrix (MetaOps features)

| MetaOps feature | Permissions | Access needed for 3rd-party businesses | Launch timing |
|---|---|---|---|
| Read Page conversations, sync inbox (FB) | `pages_messaging` (deps: `pages_manage_metadata`, `pages_show_list`), `pages_read_engagement` | Advanced + App Review | After review |
| Send Page/Messenger replies | `pages_messaging` | Advanced + App Review | After review |
| Publish Page posts | `pages_manage_posts` (deps: `pages_read_engagement`, `pages_show_list`) | Advanced + App Review | After review |
| Page insights (future) | `read_insights` | Advanced | After review |
| IG profile/media read | `instagram_basic` (or newer `instagram_business_basic`) | Advanced + App Review | After review |
| IG DM read/reply | `instagram_manage_messages` (or `instagram_business_manage_messages`) | Advanced + App Review | After review |
| IG publishing | `instagram_content_publish` (media URL required by the API) | Advanced + App Review | After review |
| WhatsApp messaging | `whatsapp_business_messaging` + `whatsapp_business_management` | Advanced; templates separately approved per template | After review + template approvals |
| Webhook subscriptions | `pages_manage_metadata` (Page), platform webhook products | Follows the underlying permission's access level | With the above |
| **Founder's own Page/IG/WhatsApp testing** | All of the above | **Standard Access suffices (role holders)** | **Immediately** |
| **Supervised-mode pilots** (MetaOps drafts; owner sends from Business Suite) | None — no API access to customer assets | n/a | **Immediately** (still tests drafting value) |

## Rate limits to engineer around (official)

App-level calls/hour = 200 × DAU; Pages: 4,800 × engaged users per 24h; IG messaging: Conversations API 2/sec per account, Send API 100/sec text; Messenger: 300/sec per Page text sends; WhatsApp Business Management API: 200 req/hr per app per WABA. MetaOps' polling sync must be replaced by webhooks before any scale (already in the 30-day plan), and the task engine's retry/backoff must respect `X-App-Usage` headers.

## Compliance work items for MetaOps (engineering backlog)

1. Privacy policy page + terms (blocks App Review).
2. Data-deletion callback endpoint implementing the signed_request flow, wired to real deletion of a business's data (MetaOps already deletes tokens on disconnect; extend to full data).
3. Instant auto-acknowledgement for inbound messages (30-second bot-response rule) that is clearly a receipt notice, not a substantive reply.
4. Webhooks implementation (verification handshake + signature validation) replacing poll sync.
5. WhatsApp: opt-in capture UX, template creation/approval workflow, template-status tracking (none built yet — see BUILD_STATUS.md).
6. IG account-type check at connect time (professional + Page-linked) with guided fix steps.
7. FounderFlo LLC reinstatement **before** Business Verification is attempted.
