import { PAIRING_TTL_MS } from "./protocol";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
};

export type MachineRow = {
  id: string;
  user_id: string;
  hostname: string;
  os: string;
  cwd: string | null;
  label: string | null;
  token_hash: string;
  last_seen: number | null;
  created_at: number;
};

export type PairingRow = {
  user_code: string;
  pairing_id: string;
  machine_id: string;
  hostname: string | null;
  os: string | null;
  cwd: string | null;
  expires_at: number;
  consumed: number;
};

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function insertUser(
  db: D1Database,
  row: Pick<UserRow, "id" | "email" | "password_hash" | "created_at">,
): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(row.id, row.email, row.password_hash, row.created_at)
    .run();
}

export async function listMachinesByUser(db: D1Database, userId: string): Promise<MachineRow[]> {
  const res = await db
    .prepare(
      `SELECT id, user_id, hostname, os, cwd, label, token_hash, last_seen, created_at
       FROM machines WHERE user_id = ? ORDER BY COALESCE(last_seen, created_at) DESC`,
    )
    .bind(userId)
    .all<MachineRow>();
  return res.results ?? [];
}

export async function getMachineById(db: D1Database, id: string): Promise<MachineRow | null> {
  return db.prepare("SELECT * FROM machines WHERE id = ?").bind(id).first<MachineRow>();
}

export async function getMachineByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<MachineRow | null> {
  return db.prepare("SELECT * FROM machines WHERE token_hash = ?").bind(tokenHash).first<MachineRow>();
}

export async function upsertMachine(
  db: D1Database,
  row: {
    id: string;
    user_id: string;
    hostname: string;
    os: string;
    cwd: string | null;
    label: string | null;
    token_hash: string;
    last_seen: number;
    created_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO machines (id, user_id, hostname, os, cwd, label, token_hash, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         hostname = excluded.hostname,
         os = excluded.os,
         cwd = excluded.cwd,
         label = excluded.label,
         token_hash = excluded.token_hash,
         last_seen = excluded.last_seen`,
    )
    .bind(
      row.id,
      row.user_id,
      row.hostname,
      row.os,
      row.cwd,
      row.label,
      row.token_hash,
      row.last_seen,
      row.created_at,
    )
    .run();
}

export async function touchMachine(
  db: D1Database,
  id: string,
  fields: { hostname?: string; os?: string; cwd?: string | null; label?: string | null; last_seen: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE machines SET
         last_seen = ?,
         hostname = COALESCE(?, hostname),
         os = COALESCE(?, os),
         cwd = COALESCE(?, cwd),
         label = COALESCE(?, label)
       WHERE id = ?`,
    )
    .bind(fields.last_seen, fields.hostname ?? null, fields.os ?? null, fields.cwd ?? null, fields.label ?? null, id)
    .run();
}

export async function getPairingByCode(db: D1Database, userCode: string): Promise<PairingRow | null> {
  return db.prepare("SELECT * FROM pairings WHERE user_code = ?").bind(userCode).first<PairingRow>();
}

export async function upsertPairing(
  db: D1Database,
  row: {
    user_code: string;
    pairing_id: string;
    machine_id: string;
    hostname?: string | null;
    os?: string | null;
    cwd?: string | null;
    expires_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pairings (user_code, pairing_id, machine_id, hostname, os, cwd, expires_at, consumed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(user_code) DO UPDATE SET
         pairing_id = excluded.pairing_id,
         machine_id = excluded.machine_id,
         hostname = COALESCE(excluded.hostname, pairings.hostname),
         os = COALESCE(excluded.os, pairings.os),
         cwd = COALESCE(excluded.cwd, pairings.cwd),
         expires_at = excluded.expires_at,
         consumed = 0`,
    )
    .bind(
      row.user_code,
      row.pairing_id,
      row.machine_id,
      row.hostname ?? null,
      row.os ?? null,
      row.cwd ?? null,
      row.expires_at,
    )
    .run();
}

export async function updatePairingMeta(
  db: D1Database,
  userCode: string,
  meta: { hostname?: string | null; os?: string | null; cwd?: string | null; machine_id?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE pairings SET
         hostname = COALESCE(?, hostname),
         os = COALESCE(?, os),
         cwd = COALESCE(?, cwd),
         machine_id = COALESCE(?, machine_id)
       WHERE user_code = ?`,
    )
    .bind(meta.hostname ?? null, meta.os ?? null, meta.cwd ?? null, meta.machine_id ?? null, userCode)
    .run();
}

export async function consumePairing(db: D1Database, userCode: string): Promise<void> {
  await db.prepare("UPDATE pairings SET consumed = 1 WHERE user_code = ?").bind(userCode).run();
}

export function pairingExpiresAt(now = Date.now()): number {
  return now + PAIRING_TTL_MS;
}
