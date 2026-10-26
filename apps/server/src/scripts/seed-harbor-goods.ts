/**
 * CLI: seed the deep Harbor Goods dataset and verify row counts.
 * Usage (after `npm run build`):  node apps/server/dist/scripts/seed-harbor-goods.js
 * Env: METAOPS_DB (db path), METAOPS_DEMO_EMAIL / METAOPS_DEMO_PASSWORD.
 */
import { buildApp } from "../index.js";
import { seedHarborDeep, verifyDeepSeed } from "../services/deep-seed.js";
import { getDb } from "../db/store.js";

const email = process.env.METAOPS_DEMO_EMAIL || "demo@metaops.local";
const password = process.env.METAOPS_DEMO_PASSWORD || "demo-password-123";

const app = await buildApp();
const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password, name: "Demo Owner" } });
let userId: string;
if (reg.statusCode === 200) {
  userId = (reg.json() as { userId: string }).userId;
} else {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  userId = (login.json() as { userId: string }).userId;
}
const { businessId } = seedHarborDeep(userId);
const counts = verifyDeepSeed(businessId);
console.log("Harbor Goods deep seed complete for business", businessId);
console.log(JSON.stringify(counts, null, 2));
const ok = counts.products >= 35 && counts.conversations >= 50 && counts.historicalTasks >= 10 && counts.historicalReceiptsValid >= 10 && counts.injections >= 3;
console.log(ok ? "SEED VERIFICATION: PASS" : "SEED VERIFICATION: FAIL");
getDb().close?.();
await app.close();
process.exit(ok ? 0 : 1);
