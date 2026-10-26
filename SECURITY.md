# Security

## Threat model & controls

- **Account security:** passwords hashed with scrypt + per-user salt; session tokens are HMAC-signed and expire in 12h; all business data is scoped by owner — cross-user access returns 404 (tested).
- **Meta tokens:** stored AES-256-GCM encrypted at rest, decrypted only server-side inside the adapter, never logged, never returned in any API response (tested). Disconnect wipes the stored token.
- **Approvals:** required for sends, publishes, and any external mutation. Approval = specific payload hash; editing invalidates; deciding twice is rejected; approvals cannot be created by the model.
- **AI containment:** operation allowlist; structured-output validation; customer content treated as untrusted data; prompt-injection probes are classified as ordinary inquiries and flagged for human review (tested with a synthetic injection conversation); drafts grounded in the KB with unknowns flagged instead of invented.
- **Idempotency & replay:** deterministic idempotency keys on all external actions; unique constraints in the DB; sandbox adapter dedupes on the same keys.
- **Rate limiting:** global API rate limit; adapter retries respect transient-error backoff.
- **Audit:** auth events, connections, approvals, task state transitions and step failures are written to an audit table.

## Known limitations (honest)

- Live Graph integrations are implemented against documented endpoints but can only be fully exercised with a Meta app that has the relevant permissions approved; sandbox mode exists precisely for the hackathon window.
- Instagram live publishing requires a media URL (Graph API constraint); text-only drafts surface this as a failure rather than pretending to publish.
- WhatsApp/Messenger live sending must respect platform messaging windows and opt-in rules; the engine does not bypass them and the UI surfaces adapter errors.
- Receipts carry a SHA-256 checksum for tamper evidence; they are **not** digitally signed.
- The optional desktop companion from the original brief was intentionally not built: official APIs cover the MVP workflows, and UI automation of Meta surfaces would risk platform policy violations.
