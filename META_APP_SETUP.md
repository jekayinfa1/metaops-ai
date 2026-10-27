# Meta Developer App Setup — First Live Integration

**Purpose:** the exact, ordered steps to take MetaOps AI from sandbox-only to its first real Meta integration. **Status (updated 2026-10-26): PARTLY DONE.** §1 is complete — the Model API key is configured and live Muse calls are verified (two full operator runs, receipted; see BUILD_STATUS.md). The developer-console app **exists**: **"FounderFlo Ops" (App ID 1671236714578648)**, Unpublished, with Messenger + Instagram use cases (§2 done, under that name — Meta rejected "MetaOps AI" as a console app name). §§3–6 remain undone: the developer account is in an account-confirmation checkpoint that blocks the console, so no permissions have been requested, no test assets connected, and **the platform half of Gate A remains unpassed**. Every step that touches Meta's console is a founder action (it requires Femi's Meta account). Times are estimates.

Prerequisite: FounderFlo LLC reinstatement is **not** needed for this first test phase (Standard Access + app roles work without Business Verification). It **is** needed later for Advanced Access / App Review (see META_API_COMPLIANCE.md).

---

## 1. Model API key (≈5 min) — unblocks live AI, independent of the app below — ✅ DONE (2026-10-26)

1. dev.meta.ai → sign in → API keys → create key. Confirm the account is on the **Standard** data tier (not Contributor) — see SECURE_KEY_SETUP.md.
2. `./scripts/set-model-key.sh` in the repo (hidden prompt, writes gitignored `.env`, chmod 600).
3. §6 smoke test A. **This alone flips the AI layer from heuristic to real Muse models**, with platform actions still in sandbox.

## 2. Create the Meta app (≈10 min) — ✅ DONE (2026-10-26, as "FounderFlo Ops")

1. developers.facebook.com → My Apps → Create App → type **Business** → name the app → attach to the FounderFlo business portfolio (create one if prompted). **Recorded outcome:** the name "MetaOps AI" was **rejected by Meta's console** (trademark — app names may not contain "Meta"); the app was created as **"FounderFlo Ops" (App ID 1671236714578648)**. The product name elsewhere is unchanged; whether "FounderFlo Ops" becomes the public-facing product name is a pending founder decision (BRANDING_REVIEW.md).
2. Record (privately, not in this repo): App ID, App Secret. The App Secret is used server-side for webhook signature verification (`X-Hub-Signature-256`) — it will be stored like the model key when webhooks are built.
3. Settings → Basic: add Privacy Policy URL and Terms URL (required for App Review later; the unpublished drafts in `validation/` are the starting point), app icon, category "Business and pages".

## 3. Add products and request the permissions MetaOps actually uses

Add products: **Facebook Login for Business** (or Facebook Login), **Messenger**, **Instagram** (Instagram API with Instagram Login *or* the Page-linked route below), **WhatsApp**, **Webhooks**.

Permissions to request — exactly these, each mapped to a shipped feature (from META_API_COMPLIANCE.md research, official docs checked 2026-10-25):

| Permission | Feature it powers |
|---|---|
| `pages_show_list` | Connection picker (list the user's Pages) |
| `pages_read_engagement` | Read Page conversations |
| `pages_messaging` | Reply on Messenger + Page inbox |
| `pages_manage_metadata` | Subscribe the app to Page webhooks |
| `pages_manage_posts` | Publish approved Page posts |
| `read_insights` | Page/IG performance tab |
| `instagram_basic` | Identify the linked IG professional account |
| `instagram_manage_messages` | Read/reply IG DMs |
| `instagram_content_publish` | Publish approved IG media (requires a hosted media URL) |
| `whatsapp_business_messaging` | Send WhatsApp messages (24h window + templates) |
| `whatsapp_business_management` | Manage WABA, phone numbers, templates |

Notes that save a rejection cycle: Instagram requires a **Business/Creator account linked to a Page**. WhatsApp needs a **WABA + registered phone number + display name**; Meta's provided **test number** is enough for the first live proof. Newer `instagram_business_*` permission names exist; request whichever set the console offers for the chosen login route and record the choice here when made.

## 4. Create test assets (≈15 min) — Standard Access covers role-holders only

Standard Access is auto-granted but only works for people with a role in the app. That is enough for Gate A's first proof: **the only user is Femi.**

1. Create a **test Facebook Page** (or use a real low-stakes Page Femi controls).
2. Create/convert an **Instagram professional account** and link it to that Page (Page Settings → Linked Accounts).
3. WhatsApp product → use the **test WABA + test number**; add Femi's real phone as an allowed recipient.
4. In the app console: Roles → add Femi's account as Admin (same account is fine).

## 5. Generate the first token and connect it in MetaOps (≈10 min)

1. Graph API Explorer → select the **"FounderFlo Ops"** app → Get Page Access Token (log in, grant the §3 permissions, pick the test Page) → copy the **Page access token**. (For durability beyond the test, exchange for a long-lived token via the server-side OAuth flow — a known follow-up; the test token proves the integration first.)
2. MetaOps → Connections → Add live connection: platform Facebook, paste the Page ID + token. The app stores it **AES-256-GCM encrypted**; the token is never returned by the API afterwards.
3. Repeat for Instagram (IG user ID + token) and WhatsApp (WABA ID + phone number ID + token) as separate live connections.

## 6. Smoke tests — the Gate A evidence bar

**A. Live AI (needs §1 only):** boot the server → `/api/ai/status` shows `configured: true`, models `muse-wonder-1.0` / `muse-spark-1.3`. Run one executive task; the receipt's `modelsUsed` must list real Muse model IDs and the auditor trail must come from the live auditor. *Pass = real model IDs in a receipt.*

**B. Live platform read (needs §2–5):** run **Sync inbox** on the live Facebook connection → real conversations from the test Page appear (compare side-by-side with the Page's real inbox). *Pass = counts/content match the platform read-back.*

**C. Live platform write:** approve one drafted reply → it appears in the real Page inbox thread (verify on facebook.com, not in MetaOps). For WhatsApp: send within the test-number window, then one approved **template** message outside any window. *Pass = the message is visible on Meta's own surface and the MetaOps receipt's read-back verification agrees.*

**D. Failure honesty:** revoke the token in the console → the next sync must surface `graph_error_*` in the receipt (not a silent success). *Pass = the failure is visible and labelled.*

Only when A–D pass may BUILD_STATUS.md and the scorecard mark **Gate A passed**. Until then every surface must keep saying "sandbox" where it is sandbox.

## 7. After the first proof (separate approvals)

- Webhooks are now BUILT (2026-10-26): callback URL `{PUBLIC_BASE_URL}/webhooks/meta`, verification handshake (GET, token = `META_WEBHOOK_VERIFY_TOKEN`), `X-Hub-Signature-256` verification with the App Secret (`META_APP_SECRET`), Page/IG/WhatsApp ingestion with provider-ID dedupe — 10 tests in `tests/live-readiness.test.ts`. Remaining: subscribe the app to the Page/IG/WABA fields in the console once the app exists, and decide the ≤30-second auto-acknowledgement question (approval-first tension, tracked in META_API_COMPLIANCE.md).
- Data-deletion callback is BUILT: `{PUBLIC_BASE_URL}/api/meta/data-deletion` verifies `signed_request` (HMAC-SHA256) and returns `{url, confirmation_code}`; status is queryable at the returned URL. Privacy policy draft: `validation/privacy-policy.md` (needs review + a hosted URL before it can be entered in app settings).
- Replace test tokens with the full server-side OAuth connect flow.
- Begin App Review preparation (Business Verification ← LLC reinstatement, screencasts per permission, data-deletion callback endpoint, privacy policy) per META_API_COMPLIANCE.md. Submission needs founder approval.
