import type { Database } from "bun:sqlite";

export type SlotStatus = "open" | "filled" | "delivered" | "expired";

export interface Slot {
  id: string;
  name: string;
  path: string;
  public_key: string;
  created_by_node: string;
  created_at: number;
  expires_at: number;
  status: SlotStatus;
  envelope: string | null;
  filled_by: string | null;
  filled_at: number | null;
  delivered_at: number | null;
}

/** How long a filled envelope waits for `slopshare wait` after the slot's own expiry. */
export const PICKUP_GRACE_MS = 60 * 60 * 1000;

export function newSlotId(): string {
  return crypto.getRandomValues(new Uint8Array(16)).toHex();
}

export function createSlot(
  db: Database,
  input: { name: string; path: string; publicKey: string; node: string; ttlMs: number },
  now = Date.now(),
): Slot {
  return db
    .query<Slot, Record<string, string | number>>(
      `INSERT INTO slots (id, name, path, public_key, created_by_node, created_at, expires_at, status)
       VALUES ($id, $name, $path, $publicKey, $node, $now, $expiresAt, 'open') RETURNING *`,
    )
    .get({
      id: newSlotId(),
      name: input.name,
      path: input.path,
      publicKey: input.publicKey,
      node: input.node,
      now,
      expiresAt: now + input.ttlMs,
    })!;
}

export function getSlot(db: Database, id: string, now = Date.now()): Slot | null {
  expireSlots(db, now);
  return db.query<Slot, [string]>("SELECT * FROM slots WHERE id = ?").get(id);
}

/** First write wins. Returns false when the slot is missing, already filled, or expired. */
export function fillSlot(db: Database, id: string, envelope: string, login: string, now = Date.now()): boolean {
  expireSlots(db, now);
  const result = db
    .query(
      `UPDATE slots SET status = 'filled', envelope = $envelope, filled_by = $login, filled_at = $now
       WHERE id = $id AND status = 'open'`,
    )
    .run({ id, envelope, login, now });
  return result.changes === 1;
}

/** Called once the CLI has written the file. Drops the ciphertext and keeps the record. */
export function markDelivered(db: Database, id: string, now = Date.now()): boolean {
  const result = db
    .query(
      `UPDATE slots SET status = 'delivered', envelope = NULL, delivered_at = $now
       WHERE id = $id AND status = 'filled'`,
    )
    .run({ id, now });
  return result.changes === 1;
}

export function expireSlots(db: Database, now = Date.now()): void {
  db.query(
    `UPDATE slots SET status = 'expired', envelope = NULL
     WHERE (status = 'open' AND expires_at <= $now)
        OR (status = 'filled' AND expires_at + $grace <= $now)`,
  ).run({ now, grace: PICKUP_GRACE_MS });
}
