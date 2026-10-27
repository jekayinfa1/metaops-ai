import "./env.js"; // must stay first: loads .env allowlist before other modules read env
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { apiRoutes } from "./routes/api.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { oauthRoutes } from "./routes/oauth.js";
import { getDb } from "./db/store.js";
import { assertSecretConfiguration, SECRET_SOURCE } from "./services/security.js";

export async function buildApp() {
  // Fail closed in production before anything else touches the secret:
  // a missing, default, or short METAOPS_SECRET aborts startup (see
  // services/security.ts). Non-production keeps the labelled dev fallback.
  assertSecretConfiguration();
  const app = Fastify({ logger: true });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  getDb();
  app.get("/health", async () => ({ ok: true, service: "metaops-ai", aiConfigured: Boolean(process.env.MODEL_API_KEY) }));
  await app.register(apiRoutes);
  await app.register(webhookRoutes);
  await app.register(oauthRoutes);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(here, "../../web/dist");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  }
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const app = await buildApp();
    if (SECRET_SOURCE === "dev-fallback") {
      app.log.warn("METAOPS_SECRET is not set: using the built-in LOCAL DEVELOPMENT secret. Anyone can forge sessions for this instance — never expose it publicly or use it in production.");
    }
    await app.listen({ port: Number(process.env.PORT || 8790), host: process.env.HOST || "0.0.0.0" });
  } catch (e) {
    console.error(`[metaops] Fatal startup error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
