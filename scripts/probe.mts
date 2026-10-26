process.env.METAOPS_DB = "/tmp/probe.db";
// Credential-free live probes through the REAL code paths:
// 1) GraphAdapter with an encrypted bogus token -> real call to graph.facebook.com,
//    expecting Meta's genuine OAuth error (proves URL construction + reachability).
// 2) Meta Model API POST without a key -> expecting an auth error.
import { GraphAdapter } from "../apps/server/src/adapters/graph.js";
import { encryptSecret } from "../apps/server/src/services/security.js";

const conn = {
  id: "probe", businessId: "probe", platform: "facebook", mode: "live",
  displayName: "probe", externalAccountId: "1234567890",
  tokenEncrypted: encryptSecret("bogus_probe_token"),
  tokenExpiresAt: null, status: "connected", permissionsJson: JSON.stringify(["pages_messaging"])
} as never;

const adapter = new GraphAdapter(conn);
try {
  const convs = await adapter.listConversations();
  console.log("GRAPH adapter probe: UNEXPECTED SUCCESS", convs.length);
} catch (e) {
  console.log("GRAPH adapter probe error (expected):", (e as Error).message.slice(0, 300));
}

const m = await fetch("https://api.meta.ai/v1/responses", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "muse-wonder-1.0", input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }] })
});
console.log("MODEL API probe status:", m.status);
console.log("MODEL API probe body:", (await m.text()).slice(0, 300));
process.exit(0);
