import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;
export interface Database_ {
  sqlite: Database.Database;
  db: Db;
  path: string;
  close(): void;
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export class DatabaseIntegrityError extends Error {
  constructor(readonly detail: string) {
    super(`La base de datos no pasó la comprobación de integridad: ${detail}`);
    this.name = 'DatabaseIntegrityError';
  }
}

/**
 * Abre SQLite con la configuración del diseño (WAL, claves foráneas, busy_timeout).
 * Un único proceso escritor (el Core); no abrir la misma BD desde otro proceso en escritura.
 */
export function openDatabase(file: string, opts: { migrationsDir?: string; verify?: boolean } = {}): Database_ {
  const isMemory = file === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;

  // Copia de seguridad previa si hay migraciones pendientes sobre una BD existente.
  if (!isMemory && fs.existsSync(file) && fs.statSync(file).size > 0 && pendingMigrations(file, migrationsDir) > 0) {
    backupFileSync(file, `${file}.premigrate-${Date.now()}.bak`);
  }

  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  if (opts.verify !== false && !isMemory) {
    const res = sqlite.pragma('quick_check', { simple: true });
    if (res !== 'ok') {
      sqlite.close();
      throw new DatabaseIntegrityError(String(res));
    }
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  return { sqlite, db, path: file, close: () => sqlite.close() };
}

function journalCount(migrationsDir: string): number {
  const j = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return j.entries.length;
}

function pendingMigrations(file: string, migrationsDir: string): number {
  const total = journalCount(migrationsDir);
  const probe = new Database(file, { readonly: true });
  try {
    const has = probe
      .prepare("select 1 from sqlite_master where type='table' and name='__drizzle_migrations'")
      .get();
    if (!has) return total;
    const applied = (probe.prepare('select count(*) c from __drizzle_migrations').get() as { c: number }).c;
    return Math.max(0, total - applied);
  } finally {
    probe.close();
  }
}

/** Copia síncrona para el caso previo a migrar (la BD aún no está abierta por nosotros). */
function backupFileSync(src: string, dest: string): void {
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

export interface BackupResult {
  ok: boolean;
  bytes: number;
  integrity: string;
}

/**
 * Backup consistente con la API oficial de SQLite (no copia el -wal a mano) y
 * verificación posterior de la copia con integrity_check.
 */
export async function backupDatabase(sqlite: Database.Database, dest: string): Promise<BackupResult> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await sqlite.backup(tmp);
  const copy = new Database(tmp, { readonly: true });
  let integrity: string;
  try {
    integrity = String(copy.pragma('integrity_check', { simple: true }));
  } finally {
    copy.close();
  }
  if (integrity !== 'ok') {
    fs.rmSync(tmp, { force: true });
    return { ok: false, bytes: 0, integrity };
  }
  fs.renameSync(tmp, dest);
  return { ok: true, bytes: fs.statSync(dest).size, integrity };
}

/** Comprueba que un backup se puede abrir y tiene el esquema esperado (prueba de restauración). */
export function verifyBackup(file: string): { ok: boolean; integrity: string; tables: string[] } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma('integrity_check', { simple: true }));
    const tables = (db.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    return { ok: integrity === 'ok' && tables.includes('project') && tables.includes('agent_run'), integrity, tables };
  } finally {
    db.close();
  }
}
