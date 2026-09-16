import type { Database } from "bun:sqlite";
import page from "./page/index.html";
import { createSlot, expireSlots, fillSlot, getSlot, markDelivered, type Slot } from "./slots";
import type { Whois } from "./tailscale";

export interface ServerConfig {
  /** Browser origin, served by `tailscale serve` in front of `webPort` on 127.0.0.1. */
  publicUrl: string;
  webPort: number;
  /** Tailnet address the agent API binds to, so every caller has a tailnet identity. */
  agentHost: string;
  agentPort: number;
  allowedLogin: string;
  allowedNodes: string[];
}

const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 256 * 1024;

export function startServers(deps: { db: Database; whois: Whois; config: ServerConfig }) {
  const { db, whois, config } = deps;
  const sweep = setInterval(() => expireSlots(db), 60_000);

  // Reached only through `tailscale serve`, which sets Tailscale-User-Login for tailnet users
  // and strips any value the client sent.
  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: config.webPort,
    development: false,
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: {
      "/s/:id": page,
      "/api/slots/:id": {
        GET: (req) =>
          withLogin(req, config, () => {
            const slot = getSlot(db, req.params.id);
            if (!slot) return error(404, "no such slot");
            return Response.json(webView(slot));
          }),
        POST: (req) =>
          withLogin(req, config, async (login) => {
            // Another site open in the same browser can POST here with this user's
            // Tailscale identity attached. Only the page's own origin may fill a slot.
            if (req.headers.get("origin") !== new URL(config.publicUrl).origin) {
              return error(403, "cross-origin request");
            }
            const body = await readJson(req);
            const envelope = body?.envelope;
            if (typeof envelope !== "string" || !envelope.startsWith("v1.")) {
              return error(400, "envelope required");
            }
            if (!fillSlot(db, req.params.id, envelope, login)) {
              const slot = getSlot(db, req.params.id);
              if (!slot) return error(404, "no such slot");
              return Response.json({ error: `slot is ${slot.status}`, status: slot.status }, { status: 409 });
            }
            return new Response(null, { status: 204 });
          }),
      },
    },
    fetch: () => error(404, "not found"),
  });

  const agent = Bun.serve({
    hostname: config.agentHost,
    port: config.agentPort,
    development: false,
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: {
      "/api/slots": {
        POST: (req, server) =>
          withNode(req, server, config, whois, async (node) => {
            const body = await readJson(req);
            const name = body?.name;
            const path = body?.path;
            const publicKey = body?.publicKey;
            const ttlSeconds: unknown = body?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
            if (typeof name !== "string" || name.length < 1 || name.length > 200) {
              return error(400, "name must be 1 to 200 characters");
            }
            if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096) {
              return error(400, "path must be absolute");
            }
            if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) {
              return error(400, "publicKey must be a base64url P-256 point");
            }
            if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) {
              return error(400, `ttlSeconds must be between 60 and ${MAX_TTL_SECONDS}`);
            }
            const slot = createSlot(db, { name, path, publicKey, node, ttlMs: ttlSeconds * 1000 });
            return Response.json(
              {
                id: slot.id,
                url: `${config.publicUrl}/s/${slot.id}#${slot.public_key}`,
                expiresAt: slot.expires_at,
              },
              { status: 201 },
            );
          }),
      },
      "/api/slots/:id": {
        GET: (req, server) =>
          withNode(req, server, config, whois, (node) => {
            const slot = getSlot(db, req.params.id);
            if (!slot || slot.created_by_node !== node) return error(404, "no such slot");
            return Response.json({
              status: slot.status,
              expiresAt: slot.expires_at,
              envelope: slot.envelope,
              filledBy: slot.filled_by,
            });
          }),
      },
      "/api/slots/:id/delivered": {
        POST: (req, server) =>
          withNode(req, server, config, whois, (node) => {
            const slot = getSlot(db, req.params.id);
            if (!slot || slot.created_by_node !== node) return error(404, "no such slot");
            if (slot.status === "delivered") return new Response(null, { status: 204 });
            if (!markDelivered(db, slot.id)) return error(409, `slot is ${slot.status}`);
            return new Response(null, { status: 204 });
          }),
      },
    },
    fetch: () => error(404, "not found"),
  });

  return {
    web,
    agent,
    async stop() {
      clearInterval(sweep);
      await Promise.all([web.stop(true), agent.stop(true)]);
    },
  };
}

function webView(slot: Slot) {
  return {
    id: slot.id,
    name: slot.name,
    path: slot.path,
    node: slot.created_by_node,
    publicKey: slot.public_key,
    status: slot.status,
    expiresAt: slot.expires_at,
  };
}

async function withLogin(
  req: Request,
  config: ServerConfig,
  handle: (login: string) => Response | Promise<Response>,
): Promise<Response> {
  const login = req.headers.get("tailscale-user-login");
  if (login !== config.allowedLogin) return error(403, "not allowed");
  return handle(login);
}

async function withNode(
  req: Request,
  server: Bun.Server<undefined>,
  config: ServerConfig,
  whois: Whois,
  handle: (node: string) => Response | Promise<Response>,
): Promise<Response> {
  // The CLI never sends Origin. Browsers always do on fetch and form POSTs, so a
  // web page on a tailnet machine can't create or read slots through this API.
  if (req.headers.has("origin")) return error(403, "browser requests not allowed");
  const remote = server.requestIP(req);
  const peer = remote ? await whois(`${remote.address}:${remote.port}`) : null;
  if (!peer || peer.login !== config.allowedLogin || !config.allowedNodes.includes(peer.node)) {
    return error(403, "not allowed");
  }
  return handle(peer.node);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
