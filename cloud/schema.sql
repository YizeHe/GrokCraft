CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  cwd TEXT,
  label TEXT,
  token_hash TEXT NOT NULL,
  last_seen INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pairings (
  user_code TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  hostname TEXT,
  os TEXT,
  cwd TEXT,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_machines_user ON machines(user_id);
