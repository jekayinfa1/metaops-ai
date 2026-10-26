# Dependency & license inventory

Runtime/build dependencies (all public npm packages under permissive licenses):

| Package | Use | License |
|---|---|---|
| fastify | API server | MIT |
| @fastify/rate-limit | API rate limiting | MIT |
| @fastify/static | Serving the built PWA | MIT |
| zod | Schema validation | MIT |
| react, react-dom | Web client | MIT |
| vite, @vitejs/plugin-react | Web build tooling | MIT |
| tailwindcss, @tailwindcss/vite | Styling | MIT |
| vite-plugin-pwa | PWA manifest/service worker | MIT |
| typescript | Language tooling | Apache-2.0 |
| vitest | Tests | MIT |
| tsx | TS dev runner | MIT |

Node.js built-ins used directly (node:sqlite, node:crypto) — no additional license obligations.
Meta Graph API and Meta Model API are used under Meta's platform terms; no Meta code is vendored.

## Hackathon licensing note (for founder review before submitting)

Before submitting, re-read the official Meta Global AI Developer Hackathon rules for: (1) any license the organizer claims over submission materials, (2) whether source code must be provided, and (3) what demo assets become public. This repository is private by default; do not publish it or hand over source until the founder has reviewed those terms. All demo data in this repo is synthetic (Harbor Goods).
