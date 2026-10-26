import type { PlatformAdapter, ConnectionRow } from "./types.js";
import { SandboxAdapter } from "./sandbox.js";
import { GraphAdapter } from "./graph.js";

export function adapterFor(conn: ConnectionRow): PlatformAdapter {
  return conn.mode === "sandbox" ? new SandboxAdapter(conn) : new GraphAdapter(conn);
}
