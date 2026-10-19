// PoC-5 (y datos de entorno) para ejecutar en la PC Windows del usuario:
//   pnpm install && pnpm poc
// Escribe poc-report.md en el directorio desde el que se lanza el comando. Cada comprobación es independiente: un fallo no
// detiene a las demás. Es una herramienta de diagnóstico, no una prueba de aceptación.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { JsonlProcessAdapter, NO_CAPABILITIES } from '@aiw/agent-adapters';
import { backupDatabase, createRepos, openDatabase, verifyBackup } from '@aiw/database';
import { createWorktree, git, removeWorktree } from '@aiw/git-engine';
import {
  availableMemBytes, baseChildEnv, freeDiskBytes, getProcessStartToken, isAlive, killTree, resolveExecutable,
} from '@aiw/platform';

type Result = { name: string; ok: boolean; detail: string; ms: number };
const results: Result[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win = process.platform === 'win32';

async function check(name: string, fn: () => Promise<string>, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<string>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message.split('\n')[0]!.slice(0, 300), ms: Date.now() - t0 });
  } finally {
    clearTimeout(timer);
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? 'OK   ' : 'FALLA'} ${r.name} — ${r.detail}`);
}

function run(file: string, args: string[], timeout = 15_000, verbatim = false): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout, windowsHide: true, windowsVerbatimArguments: verbatim }, (err, stdout, stderr) => (err ? reject(new Error(`${file}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout).trim()))),
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-poc-'));

async function main() {
  console.log(`AI Workspace · PoC de entorno · ${new Date().toISOString()}\n`);

  await check('Entorno', async () => {
    const parts = [`${process.platform} ${os.release()} ${process.arch}`, `node ${process.version}`, `RAM total ${(os.totalmem() / 2 ** 30).toFixed(1)} GB, disponible ${(availableMemBytes() / 2 ** 30).toFixed(1)} GB`, `CPU ${os.cpus().length} hilos`, `disco libre en temp ${(freeDiskBytes(os.tmpdir()) / 2 ** 30).toFixed(1)} GB`];
    if (win) {
      try {
        parts.push(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber | ConvertTo-Json -Compress)']));
      } catch (e) { parts.push(`edición no disponible (${(e as Error).message})`); }
    }
    return parts.join(' | ');
  });

  for (const tool of ['git', 'claude', 'codex', 'opencode', 'agy', 'pnpm']) {
    await check(`Herramienta: ${tool}`, async () => {
      const r = resolveExecutable(tool);
      if (!r) throw new Error('no se encuentra en PATH');
      let version = '';
      try {
        version = win && r.isShim ? await run('cmd.exe', ['/d', '/s', '/c', `""${r.path}" --version"`], 15_000, true) : await run(r.path, ['--version']);
      } catch (e) { version = `(--version falló: ${(e as Error).message.slice(0, 100)})`; }
      return `${r.path}${r.isShim ? ' [SHIM .cmd/.bat]' : ''} · ${version.split('\n')[0]}`;
    });
  }

  await check('node-pty: shell real, eco y cierre', async () => {
    const shell = win ? 'powershell.exe' : (process.env.SHELL ?? 'bash');
    const p = pty.spawn(shell, win ? ['-NoLogo'] : [], { name: 'xterm-256color', cols: 100, rows: 30, cwd: tmp, env: { ...baseChildEnv(), TERM: 'xterm-256color' } });
    let out = '';
    p.onData((d) => (out += d));
    const exited = new Promise<number>((r) => p.onExit((e) => r(e.exitCode)));
    await sleep(1500);
    p.write(win ? "Write-Output ('aiw-' + (20+22))\r" : 'echo aiw-$((20+22))\n');
    for (let i = 0; i < 60 && !out.includes('aiw-42'); i++) await sleep(100);
    if (!out.includes('aiw-42')) throw new Error(`sin eco; recibido: ${JSON.stringify(out.slice(-120))}`);
    p.kill();
    const code = await Promise.race([exited, sleep(5000).then(() => -999)]);
    if (code === -999) throw new Error('el shell no terminó tras kill()');
    return `eco correcto con ${shell}; terminó con código ${code}`;
  });

  await check('PowerShell con entorno recortado (error 8009001d)', async () => {
    if (!win) return 'solo aplica a Windows (omitido)';
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok']);
    const env = baseChildEnv();
    const viaEnv = await new Promise<string>((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok'], { env, windowsHide: true, timeout: 15_000 }, (e, so, se) => (e ? reject(new Error(String(se || e.message))) : resolve(String(so).trim()))),
    );
    return `normal: ${out}; con lista blanca de entorno: ${viaEnv}`;
  });

  await check('killTree mata al hijo y al nieto', async () => {
    const script = path.join(tmp, 'tree.mjs');
    fs.writeFileSync(script, `import { spawn } from 'node:child_process';
const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
console.log('G=' + g.pid);
setInterval(() => {}, 1000);`);
    const leader = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const gpid = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error('no se obtuvo el PID del nieto')), 8000);
      leader.stdout!.on('data', (d) => { const m = /G=(\d+)/.exec(String(d)); if (m) { clearTimeout(t); res(Number(m[1])); } });
    });
    if (!isAlive(gpid)) throw new Error('el nieto no está vivo antes de matar');
    await killTree(leader.pid!, { force: true });
    for (let i = 0; i < 40 && (isAlive(gpid) || isAlive(leader.pid!)); i++) await sleep(100);
    if (isAlive(gpid)) throw new Error('EL NIETO SIGUE VIVO (proceso huérfano)');
    if (isAlive(leader.pid!)) throw new Error('el líder sigue vivo');
    return 'sin procesos huérfanos';
  });

  await check('token de inicio de proceso', async () => {
    const a = await getProcessStartToken(process.pid);
    if (!a) throw new Error('no se pudo obtener el token');
    return `token propio: ${a}`;
  });

  await check('SQLite: abrir (WAL), migrar, backup y verificar', async () => {
    const dbf = path.join(tmp, 'db', 'core.db');
    const h = openDatabase(dbf);
    const repos = createRepos(h.db);
    repos.projects.create({ id: 'p', name: 'x', rootPath: tmp, createdAt: 1 });
    const mode = h.sqlite.pragma('journal_mode', { simple: true });
    const b = await backupDatabase(h.sqlite, path.join(tmp, 'bk', 'b.db'));
    h.close();
    const v = verifyBackup(path.join(tmp, 'bk', 'b.db'));
    if (!b.ok || !v.ok) throw new Error(`backup/verificación falló: ${JSON.stringify({ b, v })}`);
    return `journal_mode=${mode}; backup ${b.bytes} bytes, integridad ok`;
  });

  await check('Git: worktree + borrado protegido', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    const wt = await createWorktree({ repo, worktreesRoot: path.join(tmp, 'wt'), projectId: 'p1', taskId: 't1', slug: 'prueba' });
    fs.writeFileSync(path.join(wt.path, 'sucio.txt'), 'x');
    let protegido = false;
    try { await removeWorktree({ repo, path: wt.path }); } catch { protegido = true; }
    if (!protegido) throw new Error('se borró un worktree con cambios sin avisar');
    await removeWorktree({ repo, path: wt.path, force: true });
    return `rama ${wt.branch}; borrado protegido OK`;
  });

  await check('Git: rutas largas (> 260 caracteres)', async () => {
    const repo = path.join(tmp, 'repo');
    const deep = path.join(tmp, 'wtlong', 'a'.repeat(130), 'b'.repeat(130));
    const wt = await createWorktree({ repo, worktreesRoot: deep, projectId: 'p1', taskId: 't2', slug: 'larga' });
    const file = path.join(wt.path, 'c'.repeat(50) + '.txt');
    fs.writeFileSync(file, 'x');
    await removeWorktree({ repo, path: wt.path, force: true });
    return `ruta de ${wt.path.length} caracteres funcionó`;
  });

  await check('Agente desacoplado (wrapper): ejecutar, cancelar y reenganchar', async () => {
    const agent = path.join(tmp, 'agent.mjs');
    fs.writeFileSync(agent, `const m = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
if (m === 'slow') { let i = 0; const t = setInterval(() => { out({ kind: 'output.delta', text: 'tick ' + (++i) }); if (i >= 12) { clearInterval(t); process.exit(0); } }, 150); }
else if (m === 'hang') { out({ kind: 'output.delta', text: 'colgado' }); setInterval(() => {}, 1000); }`);
    const a = new JsonlProcessAdapter({ id: 'poc', displayName: 'poc', command: process.execPath, capabilities: NO_CAPABILITIES, dataPolicy: 'private-ok', buildArgs: (r) => [agent, r.prompt] });
    const take = async (s: { events: AsyncIterable<unknown> }, max = Infinity) => { const o: any[] = []; for await (const e of s.events) { o.push(e); if (o.length >= max) break; } return o; };
    const req = (id: string, prompt: string) => ({ runId: id, cwd: tmp, prompt, mode: 'read' as const, runDir: path.join(tmp, 'runs', id) });

    // reenganche
    const r1 = req('r1', 'slow');
    const s1 = await a.start(r1);
    await take(s1, 3);
    const rec = await a.recover(s1.handle, { runDir: r1.runDir, cwd: tmp });
    if (rec.status !== 'reattached') throw new Error(`recover devolvió ${rec.status}`);
    const all = await take(rec.session);
    const last = all.at(-1);
    if (!(last?.kind === 'run.finished' && last.ok === true)) throw new Error(`final inesperado: ${JSON.stringify(last)}`);
    // cancelación
    const r2 = req('r2', 'hang');
    const s2 = await a.start(r2);
    await take(s2, 1);
    await s2.cancel('force');
    const rest = await take(s2);
    const end = rest.at(-1);
    if (!(end?.kind === 'run.finished' && end.ok === false)) throw new Error(`tras cancelar: ${JSON.stringify(end)}`);
    for (let i = 0; i < 30 && isAlive(s2.handle.pid!); i++) await sleep(100);
    if (isAlive(s2.handle.pid!)) throw new Error('el wrapper sigue vivo tras cancelar');
    return `reenganche OK (${all.length} eventos), cancelación OK`;
  }, 60_000);
}

main()
  .catch((e) => console.error('error inesperado:', e))
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    const md = [
      `# Informe PoC-5 / entorno`, ``, `Fecha: ${new Date().toISOString()}`, `Resultado: ${results.length - failed.length}/${results.length} comprobaciones OK`, ``,
      `| Comprobación | Resultado | Detalle | ms |`, `|---|---|---|---|`,
      ...results.map((r) => `| ${r.name} | ${r.ok ? 'OK' : '**FALLA**'} | ${r.detail.replace(/\|/g, '\\|')} | ${r.ms} |`),
    ].join('\n');
    const report = path.join(process.env.INIT_CWD ?? process.cwd(), 'poc-report.md');
    fs.writeFileSync(report, md + '\n');
    console.log(`\n${results.length - failed.length}/${results.length} OK. Informe: ${report}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* en Windows puede quedar algún archivo en uso */ }
    process.exit(failed.length ? 1 : 0);
  });
