import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./src/db";
import { startServers } from "./src/server";
import { tailscaleIPv4, tailscaleWhois } from "./src/tailscale";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const dbPath =
  process.env.SLOPSHARE_DB ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "slopshare/slopshare.db");
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

const agentHost = await tailscaleIPv4();
const servers = startServers({
  db: openDb(dbPath),
  whois: tailscaleWhois,
  config: {
    publicUrl: required("SLOPSHARE_PUBLIC_URL"),
    webPort: Number(required("SLOPSHARE_WEB_PORT")),
    agentHost,
    agentPort: Number(required("SLOPSHARE_AGENT_PORT")),
    allowedLogin: required("SLOPSHARE_ALLOWED_LOGIN"),
    allowedNodes: required("SLOPSHARE_ALLOWED_NODES").split(",").map((n) => n.trim()),
  },
});

console.log(`web on http://127.0.0.1:${servers.web.port}, agent API on http://${agentHost}:${servers.agent.port}, db ${dbPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => servers.stop().then(() => process.exit(0)));
}
