# Security

## Threat model & controls

- **Account security:** passwords hashed with scrypt + per-user salt. Session tokens are HMAC-signed **and registered server-side**, so they can be revoked before expiry: they expire in 8 hours; sign-out revokes the current session; "sign out everywhere" and any password change revoke all of the account's sessions immediately. All business data is scoped by owner — cross-user access returns 404 (tested), including task control (pause/resume/cancel) and the task event stream. A query-string token is accepted **only** on the SSE events route (the `EventSource` client cannot set headers); every other route requires the `Authorization` header.
- **Application secret (fail-closed in production):** with `NODE_ENV=production` the server **refuses to boot** if `METAOPS_SECRET` is missing, is a known development/default value, or is shorter than 32 characters — the secret keys both session signing and the at-rest token encryption. Local development may run without it and falls back to a built-in, publicly known development secret with a loud startup warning; that fallback can never sign a production session because production refuses to start.
- **Meta tokens:** stored AES-256-GCM encrypted at rest, decrypted only server-side inside the adapter, never logged, never returned in any API response (tested). Disconnect wipes the stored token.
- **Approvals:** required for sends, publishes, and any external mutation. Approval = specific payload hash; editing invalidates; deciding twice is rejected; approvals cannot be created by the model.
- **AI containment:** operation allowlist; structured-output validation; customer content treated as untrusted data; prompt-injection probes are classified as ordinary inquiries and flagged for human review (tested with a synthetic injection conversation); drafts grounded in the KB with unknowns flagged instead of invented.
- **Idempotency & replay:** deterministic idempotency keys on all external actions; unique constraints in the DB; sandbox adapter dedupes on the same keys.
- **Rate limiting:** global API rate limit, plus dedicated auth limiters — login attempts are limited per IP+account (failures only; a success clears the counter) and registrations per IP. The task engine retries transient step failures with backoff; the Meta Model API client itself performs **no** retries — recovery lives in the engine's step/checkpoint layer (see AI_USAGE.md §5).
- **Audit:** auth events, connections, approvals, task state transitions and step failures are written to an audit table.

## Known limitations (honest)

- Live Graph integrations are implemented against documented endpoints but can only be fully exercised with a Meta app that has the relevant permissions approved; sandbox mode exists precisely for the hackathon window.
- Instagram live publishing requires a media URL (Graph API constraint); text-only drafts surface this as a failure rather than pretending to publish.
- WhatsApp/Messenger live sending must respect platform messaging windows and opt-in rules; the engine does not bypass them and the UI surfaces adapter errors.
- Receipts carry a SHA-256 checksum for tamper evidence: it detects modification of the receipt **relative to a trusted reference value of the hash**. They are **not** digitally signed — the checksum proves nothing about who authored a receipt (anyone holding altered contents can recompute a matching checksum), and there is no managed signing-key facility yet.
- The web client stores the session token in `localStorage`, so a successful XSS attack would expose it. The exposure is bounded by server-side revocation and the 8-hour TTL; migrating the session to an httpOnly cookie is the documented follow-up (noted in `apps/web/src/lib/api.ts`).
- The optional desktop companion from the original brief was intentionally not built: official APIs cover the MVP workflows, and UI automation of Meta surfaces would risk platform policy violations.
