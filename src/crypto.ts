// Shared by the browser page and the CLI. Only WebCrypto, so both run the same code.
//
// Each slot has a P-256 ECDH keypair. The CLI keeps the private key; the public key
// travels in the link. The page seals with an ephemeral keypair, HKDF-SHA256 and
// AES-256-GCM. The slot id, name and path are the GCM associated data, so a server
// that shows the page a different name or path produces an envelope the CLI rejects.

const VERSION = "v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export interface SlotContext {
  id: string;
  name: string;
  path: string;
}

export function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function generateSlotKeys(): Promise<{ publicKey: string; privateKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64u(raw), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

async function contentKey(
  privateKey: CryptoKey,
  peerRaw: Uint8Array<ArrayBuffer>,
  ephemeralRaw: Uint8Array,
  recipientRaw: Uint8Array,
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey("raw", peerRaw, ECDH, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = concat(new TextEncoder().encode(`slopshare ${VERSION}`), ephemeralRaw, recipientRaw);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function associatedData(slot: SlotContext): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([VERSION, slot.id, slot.name, slot.path]));
}

/** Encrypts `plaintext` to the slot's public key. Returns `v1.<epk>.<iv>.<ciphertext>`. */
export async function seal(publicKey: string, slot: SlotContext, plaintext: string): Promise<string> {
  const recipientRaw = fromB64u(publicKey);
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const key = await contentKey(ephemeral.privateKey, recipientRaw, ephemeralRaw, recipientRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(slot) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return [VERSION, b64u(ephemeralRaw), b64u(iv), b64u(new Uint8Array(ciphertext))].join(".");
}

/** Decrypts an envelope. Throws when the key, slot context or envelope do not match. */
export async function open(
  privateKey: JsonWebKey,
  publicKey: string,
  slot: SlotContext,
  envelope: string,
): Promise<string> {
  const [version, epk, iv, ciphertext, ...rest] = envelope.split(".");
  if (version !== VERSION || !epk || !iv || !ciphertext || rest.length) {
    throw new Error("malformed envelope");
  }
  const own = await crypto.subtle.importKey("jwk", privateKey, ECDH, false, ["deriveBits"]);
  const ephemeralRaw = fromB64u(epk);
  const key = await contentKey(own, ephemeralRaw, ephemeralRaw, fromB64u(publicKey));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64u(iv), additionalData: associatedData(slot) },
    key,
    fromB64u(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
