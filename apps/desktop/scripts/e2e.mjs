// E2E real de la app (no forma parte de vitest): lanza Electron con datos aislados, maneja el renderer
// por CDP y comprueba terminal + persistencia (CA-03) y restauración del workspace.
// Uso: node apps/desktop/scripts/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const electronBin = createRequire(path.join(desktop, 'package.json'))('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-e2e-desk-'));
const dataDir = path.join(tmp, 'data');
const userData = path.join(tmp, 'userdata');
const repo = path.join(tmp, 'repo');
const PORT = 47999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ' — ' + detail : ''}`); };

fs.mkdirSync(repo, { recursive: true });
for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i']]) execFileSync('git', a, { cwd: repo });

const env = { ...process.env, AIW_DATA_DIR: dataDir, AIW_PORT: String(PORT), AIW_ENABLE_FAKE: '1', AIW_RESERVE_MEM_GB: '0', AIW_MIN_FREE_DISK_GB: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const stop = (p) => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ya cerrado */ } };
const launch = (cdp) => spawn(electronBin, [desktop, `--remote-debugging-port=${cdp}`, `--user-data-dir=${userData}`], { env, stdio: ['ignore', fs.openSync(path.join(os.tmpdir(), 'aiw-e2e-electron.log'), 'a'), fs.openSync(path.join(os.tmpdir(), 'aiw-e2e-electron.log'), 'a')] });

async function connect(CDP) {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${CDP}/json`, { signal: AbortSignal.timeout(2000) })).json();
      const page = pages.find((p) => p.type === 'page' && p.url.includes('index.html'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0; const pending = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        const evaluate = (expression) => new Promise((res) => {
          const n = ++id; pending.set(n, res);
          ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        }).then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails.exception?.description ?? d.result.exceptionDetails)); return d.result.result.value; });
        return { evaluate, close: () => ws.close() };
      }
    } catch { /* aún no */ }
    await sleep(500);
  }
  throw new Error('no se pudo conectar al renderer');
}
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* reintento */ } await sleep(300); } return false; };
const bufferText = "(() => { const b = document.querySelector('.xterm-rows'); return b ? b.innerText : ''; })()";

let app1, app2;
try {
  // ---- 1ª ejecución
  app1 = launch(9333);
  let page = await connect(9333);
  check('la ventana carga y el Core responde', await waitFor(() => page.evaluate("document.getElementById('status').textContent.includes('conectado')")));
  const prj = await page.evaluate(`window.aiw.request('POST','/v1/projects',{path:${JSON.stringify(repo)}}).then(r=>r.body)`);
  check('proyecto añadido vía proxy', Boolean(prj && prj.id));
  await page.evaluate(`(async()=>{const s=document.getElementById('project');const r=await window.aiw.request('GET','/v1/projects');s.replaceChildren(...r.body.projects.map(p=>Object.assign(document.createElement('option'),{value:p.id,textContent:p.name})));s.value=${JSON.stringify(prj.id)};s.dispatchEvent(new Event('change'));})()`);
  await page.evaluate("document.getElementById('term-new').click()");
  const termId = await waitFor(() => page.evaluate("document.getElementById('term-select').value"));
  check('terminal creado', Boolean(termId), String(termId));
  await sleep(2500);
  const cmd = process.platform === 'win32' ? 'echo persistencia-$(40+2)\\r' : 'echo persistencia-$((40+2))\\n';
  await page.evaluate(`window.aiw.term.input(${JSON.stringify(termId)}, "${cmd}")`);
  check('eco del terminal (ConPTY) visible en xterm', await waitFor(async () => (await page.evaluate(bufferText)).includes('persistencia-42')));
  const tok = fs.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim();
  const direct = await fetch(`http://127.0.0.1:${PORT}/v1/runs`, { headers: { authorization: `Bearer ${tok}` } });
  check('el renderer no expone el token', !(await page.evaluate(`JSON.stringify(Object.keys(window.aiw))`)).includes('token') && direct.status === 200);
  const forbidden = await page.evaluate("window.aiw.request('GET','/v1/terminals').then(r=>r.status)");
  check('el renderer no puede llamar rutas fuera de la lista blanca', forbidden === 403, String(forbidden));
  // ---- Revisión y fusión (CA-04) con el adaptador simulado: el "trabajo del agente" se escribe en su worktree.
  const mkRun = (title) => page.evaluate(`window.aiw.request('POST','/v1/runs',{projectId:${JSON.stringify(prj.id)},adapter:'fake',prompt:'x',mode:'write',title:${JSON.stringify(title)}}).then(r=>r.body)`);
  const runInfo = (id) => page.evaluate(`window.aiw.request('GET','/v1/runs/${id}').then(r=>r.body)`);
  const finished = async (id) => waitFor(async () => { const r = await runInfo(id); return r.state === 'completed' && r.worktreePath ? r : false; }, 20000);
  const created = await mkRun('cambio A');
  const runA = await finished(created.id);
  const runB = await finished((await mkRun('cambio B')).id);
  fs.writeFileSync(path.join(runA.worktreePath, 'notas.txt'), 'linea del agente A\n');
  fs.writeFileSync(path.join(runB.worktreePath, 'notas.txt'), 'linea del agente B\n');
  const clickReview = async (title) => {
    await page.evaluate("document.getElementById('review-close').click()");
    return page.evaluate(`(() => { const row = [...document.querySelectorAll('#runs tr')].find(r => r.textContent.includes(${JSON.stringify(title)})); const b = row && [...row.querySelectorAll('button')].find(x => x.textContent === 'Revisar cambios'); if (!b) return false; b.click(); return true; })()`);
  };
  check('la lista muestra "Revisar cambios" para un run de escritura completado', await waitFor(() => clickReview('cambio A'), 20000));
  check('la vista de diff muestra el cambio del agente', await waitFor(() => page.evaluate("document.getElementById('review-patch').textContent.includes('+linea del agente A')")));
  check('aprobar y fusionar lleva el cambio a la rama principal', await (async () => {
    await waitFor(() => page.evaluate("!document.getElementById('review-merge').disabled"));
    await page.evaluate("document.getElementById('review-merge').click()");
    return waitFor(() => fs.existsSync(path.join(repo, 'notas.txt')) && fs.readFileSync(path.join(repo, 'notas.txt'), 'utf8').replaceAll('\r\n', '\n') === 'linea del agente A\n', 15000);
  })());
  check('el run fusionado queda marcado y su worktree limpiado', await waitFor(async () => (await runInfo(runA.id)).worktreeStatus === 'merged') && await waitFor(() => !fs.existsSync(runA.worktreePath), 10000));
  check('el segundo run (mismo archivo) abre su revisión', await waitFor(() => clickReview('cambio B'), 20000));
  await waitFor(() => page.evaluate("!document.getElementById('review-merge').disabled"));
  await page.evaluate("document.getElementById('review-merge').click()");
  check('el conflicto se informa en la interfaz', await waitFor(() => page.evaluate("document.getElementById('review-msg').textContent.includes('Conflicto')")));
  check('tras el conflicto: rama principal intacta y trabajo del agente a salvo',
    fs.readFileSync(path.join(repo, 'notas.txt'), 'utf8').replaceAll('\r\n', '\n') === 'linea del agente A\n'
    && fs.readFileSync(path.join(runB.worktreePath, 'notas.txt'), 'utf8').replaceAll('\r\n', '\n') === 'linea del agente B\n'
    && execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim() === '');

  // Cierre normal de la ventana (como el usuario): la app sale sola y el Core desacoplado sigue vivo.
  await Promise.race([page.evaluate('window.close()'), sleep(1000)]).catch(() => {});
  page.close();
  check('la app se cierra al cerrar la ventana', await waitFor(() => app1.exitCode !== null, 10000));
  await sleep(1500);

  // ---- Core sobrevive (CA-03)
  const health = await fetch(`http://127.0.0.1:${PORT}/v1/health`).then((r) => r.json()).catch(() => null);
  check('CA-03: el Core sigue vivo tras cerrar Electron', Boolean(health && health.ok));
  const terms = await fetch(`http://127.0.0.1:${PORT}/v1/terminals`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json());
  check('CA-03: el terminal sigue vivo en el Core', terms.terminals.some((t) => t.id === termId && !t.exited));

  // ---- 2ª ejecución: reconexión y workspace
  app2 = launch(9334);
  page = await connect(9334);
  check('workspace restaurado: proyecto seleccionado', await waitFor(() => page.evaluate(`document.getElementById('project').value === ${JSON.stringify(prj.id)}`)));
  check('CA-03: reconecta al terminal y recupera el scrollback', await waitFor(async () => (await page.evaluate(bufferText)).includes('persistencia-42')));
  page.close();
} catch (e) {
  check('ejecución sin excepciones', false, String(e.message || e));
} finally {
  for (const a of [app1, app2]) if (a) stop(a);
  try {
    const pids = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'services.core.src.main' -and $_.CommandLine -notmatch 'Get-Cim' } | % { $_.ProcessId }`]).toString().trim().split(/\s+/).filter(Boolean);
    for (const p of pids) process.kill(Number(p));
    console.log(`Core de la prueba detenido (${pids.length})`);
  } catch { /* nada */ }
  await sleep(1000);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temporal */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
