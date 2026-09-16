import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirmCode, generateSlotKeys, open } from "./crypto";

export interface AgentOptions {
  baseUrl: string;
  keyDir: string;
  pollMs?: number;
}

interface KeyFile {
  id: string;
  name: string;
  path: string;
  publicKey: string;
  privateKey: JsonWebKey;
}

export async function defaultAgentOptions(): Promise<AgentOptions> {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const urlFile = join(configHome, "slopshare/url");
  const baseUrl = process.env.SLOPSHARE_URL ?? (await readFile(urlFile, "utf8").catch(() => "")).trim();
  if (!baseUrl) throw new Error(`set SLOPSHARE_URL or write the agent API URL to ${urlFile}`);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), keyDir: join(stateHome, "slopshare/keys") };
}

export async function createSlot(
  options: AgentOptions,
  input: { name: string; path: string; ttlSeconds?: number },
): Promise<{ id: string; url: string; expiresAt: number }> {
  const path = resolve(input.path);
  const keys = await generateSlotKeys();
  const response = await fetch(`${options.baseUrl}/api/slots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, path, publicKey: keys.publicKey, ttlSeconds: input.ttlSeconds }),
  });
  if (!response.ok) throw new Error(`create failed: ${await describe(response)}`);
  const slot = (await response.json()) as { id: string; url: string; expiresAt: number };

  await mkdir(options.keyDir, { recursive: true, mode: 0o700 });
  const keyFile: KeyFile = { id: slot.id, name: input.name, path, ...keys };
  await writeFile(keyPath(options, slot.id), JSON.stringify(keyFile), { mode: 0o600, flag: "wx" });
  return slot;
}

/** Waits for the slot to be filled, then writes the decrypted value to the slot's path. */
export async function waitForSlot(
  options: AgentOptions,
  id: string,
): Promise<{ path: string; bytes: number; confirm: string }> {
  const file = keyPath(options, id);
  const key = JSON.parse(await readFile(file, "utf8").catch(() => {
    throw new Error(`no key for slot ${id} in ${options.keyDir}`);
  })) as KeyFile;

  for (;;) {
    const response = await fetch(`${options.baseUrl}/api/slots/${id}`);
    if (!response.ok) throw new Error(`wait failed: ${await describe(response)}`);
    const slot = (await response.json()) as { status: string; envelope: string | null };

    if (slot.status === "filled" && slot.envelope) {
      const value = await open(key.privateKey, key.publicKey, key, slot.envelope).catch(() => {
        throw new Error("the value could not be decrypted with this slot's key; it was not written");
      });
      await writeAtomically(key.path, value);
      const delivered = await fetch(`${options.baseUrl}/api/slots/${id}/delivered`, { method: "POST" });
      if (!delivered.ok) throw new Error(`wrote ${key.path} but could not mark it delivered: ${await describe(delivered)}`);
      await rm(file, { force: true });
      return { path: key.path, bytes: Buffer.byteLength(value), confirm: await confirmCode(slot.envelope) };
    }
    if (slot.status === "expired" || slot.status === "delivered") {
      await rm(file, { force: true });
      throw new Error(`slot is ${slot.status}`);
    }
    await Bun.sleep(options.pollMs ?? 2000);
  }
}

async function writeAtomically(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.slopshare-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, value, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

function keyPath(options: AgentOptions, id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`invalid slot id: ${id}`);
  return join(options.keyDir, `${id}.json`);
}

async function describe(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return `HTTP ${response.status}${body?.error ? ` ${body.error}` : ""}`;
}
