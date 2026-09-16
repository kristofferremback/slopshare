import { Database } from "bun:sqlite";

// Schema versions follow `PRAGMA user_version`. Each entry runs once, in order, inside
// the same transaction as its version bump.
const MIGRATIONS = [
  `CREATE TABLE slots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    public_key TEXT NOT NULL,
    created_by_node TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'filled', 'delivered', 'expired')),
    envelope TEXT,
    filled_by TEXT,
    filled_at INTEGER,
    delivered_at INTEGER
  )`,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: current } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  if (current > MIGRATIONS.length) {
    throw new Error(`database is at schema v${current}, this build knows v${MIGRATIONS.length}`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
