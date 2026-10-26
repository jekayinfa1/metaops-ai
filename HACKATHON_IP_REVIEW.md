# MetaOps AI — Hackathon IP Review

**Date:** 2026-10-25 · **Owner:** FounderFlo LLC (Femi Jekayinfa) · **Status:** internal review. The hackathon's official rules/terms must be re-read by the founder before submission; this document flags what to look for, it is not legal advice.

## Separation record (Floaty)

- MetaOps AI was written from scratch in its own repository (`~/workspace/metaops-ai`, created 2026-10-25) under an explicit founder mandate: no Floaty code, designs, copy, credentials, infrastructure, or assets were accessed, inspected, copied, or reused at any point. Development tooling never opened any Floaty directory during this build.
- The codebase is original to this project: git history begins with the MetaOps scaffold (commit `00def52`, 2026-10-25) and the full application commit (`48c4d76`, 2026-10-25) — a clean, timestamped chain of original implementation.
- No FounderFlo/Floaty trademarks, branding, or trade dress are used; the product name, demo business (Harbor Goods), and all data are new and synthetic.
- Keep it that way: do not import Floaty components "to save time" later; the separation is both an IP-hygiene and a hackathon-integrity asset.

## What a private repo does NOT protect

A private repository protects the code **in the repo**. It does not protect anything the submission process asks you to hand over separately:

| Material | Exposure risk |
|---|---|
| Source code, if the submission requires repo access or upload | Organisers/judges may receive a broad licence (common hackathon language: royalty-free, worldwide, sublicensable rights to use, reproduce, and display the submission for judging, promotion, and marketing). Assume anything uploaded can be kept and shown. |
| Demo video / screenshots | Typically licensed for promotional reuse; do not show real credentials, real customer data, or unreleased Floaty material in frame. The Harbor Goods synthetic demo is safe by construction. |
| Written submission (problem, solution, traction claims) | May be published by organisers. Keep claims accurate (sandbox vs live status is stated honestly in SUBMISSION.md) — overstated claims are both an integrity and a licence-scope problem. |
| Live demo access (test accounts/logins) | Treat any credentials shared with judges as public: use a dedicated demo account with synthetic data only, rotate/revoke after judging. |
| The idea itself | Ideas are not protected by the repo's privacy. The moat is implementation + speed + the trust/verification design, not secrecy of the concept. |

## Clauses to verify in the official rules before submitting (founder checklist)

1. **Licence grant scope** — does entering grant the organisers (Meta/Devpost/etc.) rights beyond judging (e.g., marketing use, derivative works)? For which materials?
2. **Source-code requirement** — is full source required, or a repo link/demo sufficient? Flag any requirement to provide unrestricted source or unrestricted production access.
3. **IP ownership statement** — confirm the rules state entrants retain ownership; note any exception for "submission materials".
4. **Pre-existing IP carve-out** — confirm pre-existing code/ IP remains the entrant's; MetaOps is newly written for this event, which simplifies this, but the carve-out still matters for FounderFlo's other assets if any cross-referencing appears in materials.
5. **Publicity rights** — use of founder name/likeness/product in winner announcements.
6. **Data terms** — what happens to data collected through the demo during judging.

These items were already flagged in `LICENSES.md` at build time (§"Hackathon submission — founder must check"), which stands: **re-check the official terms at submission time; terms at signup may differ.**

## Rules for any submission package (binding until founder overrides)

- Submit only: submission text (from SUBMISSION.md), demo video of the sandbox flow, screenshots of the PWA, and — if required — a **read-only, revocable** repo view or a source snapshot the founder has reviewed file-by-file.
- Never submit: `MODEL_API_KEY` or any credential, the Floaty repo or any Floaty material, real customer data (none exists), or unrestricted admin access to a live deployment.
- Nothing is submitted, published, or deployed without the founder's explicit approval of the exact package.

## Residual risks

- **Broad-licence risk (medium):** standard for hackathons; mitigated by submitting the minimum materials and keeping the repo private until terms are reviewed.
- **Confusion risk (low):** MetaOps AI and Floaty are thematically adjacent (both AI-agent products). The separation record above, distinct branding, and distinct repos keep the boundary provable.
- **Post-hackathon commercialisation:** confirm the rules impose no exclusivity, right of first refusal, or licence-back on the *business* (as opposed to submission materials) before signing anything beyond the entry terms.
