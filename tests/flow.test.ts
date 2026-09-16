import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlot, waitForSlot, type AgentOptions } from "../src/agent";
import { seal } from "../src/crypto";
import { openDb } from "../src/db";
import { startServers } from "../src/server";
import { getSlot } from "../src/slots";
import type { Peer } from "../src/tailscale";

const LOGIN = "owner@example.com";
const PAGE_ORIGIN = "https://homelab.example.ts.net:20160";
const dir = mkdtempSync(join(tmpdir(), "slopshare-tests-"));
const db = openDb(join(dir, "test.db"));

// Tailscale whois is the one boundary faked here: every test request comes from 127.0.0.1.
let peer: Peer | null = { node: "homelab", login: LOGIN };
const servers = startServers({
  db,
  whois: async () => peer,
  config: {
    publicUrl: PAGE_ORIGIN,
    webPort: 0,
    agentHost: "127.0.0.1",
    agentPort: 0,
    allowedLogin: LOGIN,
    allowedNodes: ["homelab", "mbp"],
  },
});
const webUrl = `http://127.0.0.1:${servers.web.port}`;
let agent: AgentOptions;

beforeAll(() => {
  agent = { baseUrl: `http://127.0.0.1:${servers.agent.port}`, keyDir: join(dir, "keys"), pollMs: 20 };
});
beforeEach(() => {
  peer = { node: "homelab", login: LOGIN };
});
afterAll(async () => {
  await servers.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Does what the page does: loads the slot, checks the link key, seals, posts. */
async function fillFromBrowser(url: string, value: string, { login = LOGIN, origin = PAGE_ORIGIN } = {}) {
  const { pathname, hash } = new URL(url);
  const id = pathname.split("/").pop()!;
  const headers = { "tailscale-user-login": login };
  const view = (await (await fetch(`${webUrl}/api/slots/${id}`, { headers })).json()) as {
    id: string;
    name: string;
    path: string;
    publicKey: string;
  };
  expect(hash.slice(1)).toBe(view.publicKey);
  const envelope = await seal(view.publicKey, view, value);
  const response = await fetch(`${webUrl}/api/slots/${id}`, {
    method: "POST",
    headers: { ...headers, origin, "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  return { response };
}

describe("slot flow", () => {
  test("should write the pasted value to the slot path when the link is filled", async () => {
    const path = join(dir, "out", "openai-key");
    const slot = await createSlot(agent, { name: "openai key", path });
    const waiting = waitForSlot(agent, slot.id);

    const { response } = await fillFromBrowser(slot.url, "sk-secret-value\n");
    expect(response.status).toBe(204);

    expect(await waiting).toEqual({ path, bytes: 16 });
    expect(readFileSync(path, "utf8")).toBe("sk-secret-value\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(agent.keyDir)).toEqual([]);
    expect(getSlot(db, slot.id)).toMatchObject({ status: "delivered", envelope: null, filled_by: LOGIN });
  });

  test("should serve the page for a slot link", async () => {
    const slot = await createSlot(agent, { name: "page", path: join(dir, "page") });
    const response = await fetch(`${webUrl}/s/${slot.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<textarea");
  });

  test("should reject a second fill when the slot already has a value", async () => {
    const slot = await createSlot(agent, { name: "once", path: join(dir, "once") });
    expect((await fillFromBrowser(slot.url, "first")).response.status).toBe(204);
    const second = (await fillFromBrowser(slot.url, "second")).response;
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "slot is filled", status: "filled" });
  });

  test("should reject a fill when the slot has expired", async () => {
    const slot = await createSlot(agent, { name: "late", path: join(dir, "late"), ttlSeconds: 60 });
    db.query("UPDATE slots SET expires_at = 0 WHERE id = ?").run(slot.id);
    const { response } = await fillFromBrowser(slot.url, "too late");
    expect(await response.json()).toEqual({ error: "slot is expired", status: "expired" });
    await expect(waitForSlot(agent, slot.id)).rejects.toThrow("slot is expired");
  });

  test("should refuse browsers that are not the allowed tailnet login", async () => {
    const slot = await createSlot(agent, { name: "x", path: join(dir, "x") });
    const id = new URL(slot.url).pathname.split("/").pop();
    const anonymous = await fetch(`${webUrl}/api/slots/${id}`);
    const stranger = await fetch(`${webUrl}/api/slots/${id}`, { headers: { "tailscale-user-login": "eve@example.com" } });
    expect([anonymous.status, stranger.status]).toEqual([403, 403]);
  });

  test("should refuse to create slots from nodes outside the allowlist", async () => {
    peer = { node: "phone", login: LOGIN };
    await expect(createSlot(agent, { name: "x", path: join(dir, "x") })).rejects.toThrow("HTTP 403");
    peer = null;
    await expect(createSlot(agent, { name: "x", path: join(dir, "x") })).rejects.toThrow("HTTP 403");
  });

  test("should hide a slot from nodes other than the one that created it", async () => {
    const slot = await createSlot(agent, { name: "mine", path: join(dir, "mine") });
    peer = { node: "mbp", login: LOGIN };
    await expect(waitForSlot(agent, slot.id)).rejects.toThrow("HTTP 404");
  });

  test("should not write the file when the server changed the slot's name or path", async () => {
    const path = join(dir, "tampered");
    const slot = await createSlot(agent, { name: "real", path });
    db.query("UPDATE slots SET path = '/tmp/elsewhere' WHERE id = ?").run(slot.id);
    await fillFromBrowser(slot.url, "value");
    await expect(waitForSlot(agent, slot.id)).rejects.toThrow("could not be decrypted");
    expect(() => statSync(path)).toThrow();
  });

  test("should refuse a fill posted from another site when the browser is logged in", async () => {
    const slot = await createSlot(agent, { name: "csrf", path: join(dir, "csrf") });
    const { response } = await fillFromBrowser(slot.url, "attacker value", { origin: "https://evil.example" });
    expect({ status: response.status, slot: getSlot(db, slot.id)?.status }).toEqual({ status: 403, slot: "open" });
  });

  test("should refuse agent API requests that come from a browser", async () => {
    const slot = await createSlot(agent, { name: "browser", path: join(dir, "browser") });
    const headers = { origin: "https://evil.example", "content-type": "application/json" };
    const created = await fetch(`${agent.baseUrl}/api/slots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "x", path: "/tmp/x", publicKey: "A".repeat(87) }),
    });
    const read = await fetch(`${agent.baseUrl}/api/slots/${slot.id}`, { headers });
    expect([created.status, read.status]).toEqual([403, 403]);
  });
});
