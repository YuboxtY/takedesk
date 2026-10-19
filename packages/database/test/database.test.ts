import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRetention, backupDatabase, createRepos, DatabaseIntegrityError, openDatabase, readRunEvents, RunEventLog,
  verifyBackup, type Database_,
} from '../src';

let dir: string;
let handle: Database_ | undefined;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-db-')); });
afterEach(() => { handle?.close(); handle = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

function seedProject(repos: ReturnType<typeof createRepos>) {
  return repos.projects.create({ id: 'p1', name: 'demo', rootPath: '/tmp/demo', createdAt: 1 });
}
function seedRun(repos: ReturnType<typeof createRepos>, id: string, over: Record<string, unknown> = {}) {
  return repos.runs.create({
    id, projectId: 'p1', adapter: 'fake', mode: 'write', prompt: 'x', state: 'queued',
    runDir: path.join(dir, 'runs', id), createdAt: 1, ...over,
  });
}

describe('base de datos', () => {
  it('abre en WAL con claves foráneas y migra', () => {
    handle = openDatabase(path.join(dir, 'core.db'));
    expect(handle.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    const repos = createRepos(handle.db);
    seedProject(repos);
    expect(repos.projects.list()).toHaveLength(1);
  });

  it('las claves foráneas se hacen cumplir', () => {
    handle = openDatabase(path.join(dir, 'core.db'));
    const repos = createRepos(handle.db);
    expect(() => seedRun(repos, 'r1')).toThrow(/FOREIGN KEY/i);
  });

  it('reabrir no vuelve a migrar ni pierde datos', () => {
    const file = path.join(dir, 'core.db');
    handle = openDatabase(file);
    seedProject(createRepos(handle.db));
    handle.close();
    handle = openDatabase(file);
    expect(createRepos(handle.db).projects.get('p1')?.name).toBe('demo');
    expect(fs.readdirSync(dir).filter((f) => f.includes('premigrate'))).toHaveLength(0);
  });

  it('hace backup previo si hay migraciones pendientes sobre una BD existente', () => {
    const file = path.join(dir, 'core.db');
    // BD "antigua": solo la tabla de control vacía y una tabla con datos
    const old = new Database(file);
    old.exec('create table legacy(a text); insert into legacy values (\'dato\');');
    old.close();
    handle = openDatabase(file);
    const baks = fs.readdirSync(dir).filter((f) => f.includes('premigrate'));
    expect(baks).toHaveLength(1);
    const bak = new Database(path.join(dir, baks[0]!), { readonly: true });
    expect(bak.prepare('select a from legacy').get()).toEqual({ a: 'dato' });
    bak.close();
  });

  it('detecta una BD corrupta al abrir', () => {
    const file = path.join(dir, 'core.db');
    handle = openDatabase(file);
    seedProject(createRepos(handle.db));
    handle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    handle.close();
    handle = undefined;
    const buf = fs.readFileSync(file);
    // corrompe una página interior (conserva la cabecera)
    for (let i = 4096; i < Math.min(buf.length, 4096 + 2048); i++) buf[i] = 0xff;
    fs.writeFileSync(file, buf);
    expect(() => openDatabase(file)).toThrow();
  });
});

describe('backup y restauración', () => {
  it('backup consistente + verificación de la copia', async () => {
    handle = openDatabase(path.join(dir, 'core.db'));
    const repos = createRepos(handle.db);
    seedProject(repos);
    seedRun(repos, 'r1');
    const res = await backupDatabase(handle.sqlite, path.join(dir, 'backups', 'b1.db'));
    expect(res.ok).toBe(true);
    const v = verifyBackup(path.join(dir, 'backups', 'b1.db'));
    expect(v.ok).toBe(true);
    // restauración: abrir la copia como BD y leer
    const restored = openDatabase(path.join(dir, 'backups', 'b1.db'));
    expect(createRepos(restored.db).runs.get('r1')?.id).toBe('r1');
    restored.close();
  });

  it('backup mientras otro hilo de ejecución sigue escribiendo (escritura sostenida)', async () => {
    handle = openDatabase(path.join(dir, 'core.db'));
    const repos = createRepos(handle.db);
    seedProject(repos);
    seedRun(repos, 'r1', { state: 'running' });
    let n = 0;
    let stop = false;
    const writer = (async () => {
      while (!stop) {
        for (let i = 0; i < 200; i++) repos.eventIndex.add({ runId: 'r1', seq: ++n, kind: 'output.delta', fileOffset: n, summary: 'x'.repeat(200), ts: n });
        await new Promise((r) => setImmediate(r));
      }
    })();
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await backupDatabase(handle.sqlite, path.join(dir, `b${i}.db`)));
    stop = true;
    await writer;
    expect(results.every((r) => r.ok)).toBe(true);
    expect(n).toBeGreaterThan(1000);
    for (let i = 0; i < 3; i++) expect(verifyBackup(path.join(dir, `b${i}.db`)).ok).toBe(true);
  });
});

describe('log de eventos NDJSON', () => {
  it('append devuelve offsets, redacta secretos y se puede leer desde un seq', () => {
    const file = path.join(dir, 'e.ndjson');
    const log = new RunEventLog(file);
    const a = log.append({ runId: 'r', seq: 1, ts: 1, event: { kind: 'output.delta', text: 'hola', stream: 'stdout' } });
    const b = log.append({ runId: 'r', seq: 2, ts: 2, event: { kind: 'output.delta', text: 'token Bearer abcdefghijklmnop123', stream: 'stdout' } });
    log.close();
    expect(a.offset).toBe(0);
    expect(b.offset).toBe(a.bytes);
    const all = readRunEvents(file);
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain('abcdefghijklmnop123');
    expect(readRunEvents(file, 1).map((e) => e.seq)).toEqual([2]);
  });

  it('trunca eventos voluminosos y tolera una última línea incompleta', () => {
    const file = path.join(dir, 'e.ndjson');
    const log = new RunEventLog(file, 1024);
    const r = log.append({ runId: 'r', seq: 1, ts: 1, event: { kind: 'output.delta', text: 'x'.repeat(10_000), stream: 'stdout' } });
    log.close();
    expect(r.bytes).toBeLessThan(1500);
    fs.appendFileSync(file, '{"runId":"r","seq":2,"ts":2,"event":{"kind":"outp'); // caída a mitad de escritura
    expect(readRunEvents(file).map((e) => e.seq)).toEqual([1]);
  });
});

describe('retención', () => {
  it('purga detalle de runs terminados antiguos y conserva el resumen', () => {
    handle = openDatabase(path.join(dir, 'core.db'));
    const repos = createRepos(handle.db);
    seedProject(repos);
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const old = seedRun(repos, 'old', { state: 'completed', endedAt: now - 20 * DAY });
    const recent = seedRun(repos, 'recent', { state: 'completed', endedAt: now - 1 * DAY });
    const active = seedRun(repos, 'active', { state: 'running' });
    for (const r of [old, recent, active]) {
      fs.mkdirSync(r.runDir, { recursive: true });
      fs.writeFileSync(path.join(r.runDir, 'events.ndjson'), 'x'.repeat(1000));
      repos.eventIndex.add({ runId: r.id, seq: 1, kind: 'k', fileOffset: 0, summary: 's', ts: 1 });
    }
    repos.coreEvents.append(now - 30 * DAY, 'run.created', {}, {});
    repos.coreEvents.append(now - 1 * DAY, 'run.created', {}, {});

    const res = applyRetention(repos, now);
    expect(res).toEqual({ runsPurged: 1, bytesFreed: 1000, coreEventsDeleted: 1 });
    expect(fs.existsSync(path.join(old.runDir, 'events.ndjson'))).toBe(false);
    expect(fs.existsSync(path.join(recent.runDir, 'events.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(active.runDir, 'events.ndjson'))).toBe(true);
    expect(repos.runs.get('old')?.detailPurged).toBe(1);
    expect(repos.eventIndex.list('old', 0, 10)).toHaveLength(0);
    expect(repos.eventIndex.list('recent', 0, 10)).toHaveLength(1);
    // idempotente
    expect(applyRetention(repos, now).runsPurged).toBe(0);
  });
});

describe('eventos durables del Core', () => {
  it('ids monótonos y lectura desde un id', () => {
    handle = openDatabase(path.join(dir, 'core.db'));
    const repos = createRepos(handle.db);
    const ids = [1, 2, 3].map((i) => repos.coreEvents.append(i, 'run.created', {}, { i }));
    expect(ids).toEqual([1, 2, 3]);
    expect(repos.coreEvents.since(1).map((e) => e.id)).toEqual([2, 3]);
    expect(repos.coreEvents.lastId()).toBe(3);
    expect(DatabaseIntegrityError).toBeDefined();
  });
});
