// E2E real de la app (no forma parte de vitest): lanza Electron con datos aislados, maneja el renderer
// por CDP y comprueba el lienzo de paneles: varios terminales y varios agentes a la vez, cada uno en su panel,
// revisión/fusión, arrastrar/redimensionar, persistencia del layout y supervivencia al cierre (CA-03).
// Uso: node apps/desktop/scripts/e2e.mjs   (E2E_SHOT=ruta.png guarda una captura del lienzo)
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
const norm = (s) => s.replaceAll('\r\n', '\n');

fs.mkdirSync(repo, { recursive: true });
for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i']]) execFileSync('git', a, { cwd: repo });

const env = { ...process.env, AIW_DATA_DIR: dataDir, AIW_PORT: String(PORT), AIW_ENABLE_FAKE: '1', AIW_RESERVE_MEM_GB: '0', AIW_MIN_FREE_DISK_GB: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const stop = (p) => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ya cerrado */ } };
const logFile = path.join(os.tmpdir(), 'aiw-e2e-electron.log');
const launch = (cdp) => spawn(electronBin, [desktop, `--remote-debugging-port=${cdp}`, `--user-data-dir=${userData}`], { env, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')] });

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
        const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
        const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails.exception?.description ?? d.result.exceptionDetails)); return d.result.result.value; });
        return { evaluate, send, close: () => ws.close() };
      }
    } catch { /* aún no */ }
    await sleep(500);
  }
  throw new Error('no se pudo conectar al renderer');
}
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* reintento */ } await sleep(300); } return false; };

// ---- ayudantes de DOM (se ejecutan en el renderer)
const tiles = (type) => `[...document.querySelectorAll('.tile[data-type="${type}"]')]`;
const countTiles = (page, type) => page.evaluate(`${tiles(type)}.length`);
const click = (page, sel) => page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
const tileText = (page, type, i, sel) => page.evaluate(`(() => { const t = ${tiles(type)}[${i}]; const e = t && t.querySelector(${JSON.stringify(sel)}); return e ? (e.innerText ?? e.textContent) : ''; })()`);
const inTile = (page, type, i, sel, js) => page.evaluate(`(() => { const t = ${tiles(type)}[${i}]; const e = t && t.querySelector(${JSON.stringify(sel)}); if (!e) return false; ${js}; return true; })()`);
const rect = (page, type, i) => page.evaluate(`(() => { const t = ${tiles(type)}[${i}]; return t ? { x: parseInt(t.style.left), y: parseInt(t.style.top), w: parseInt(t.style.width), h: parseInt(t.style.height) } : null; })()`);
const pointer = (page, type, i, sel, dx, dy) => page.evaluate(`(() => {
  const t = ${tiles(type)}[${i}]; const e = t.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect();
  const x = r.left + 20, y = r.top + 5; const o = (cx, cy) => ({ bubbles: true, button: 0, clientX: cx, clientY: cy });
  e.dispatchEvent(new PointerEvent('pointerdown', o(x, y)));
  window.dispatchEvent(new PointerEvent('pointermove', o(x + ${dx}, y + ${dy})));
  window.dispatchEvent(new PointerEvent('pointerup', o(x + ${dx}, y + ${dy})));
  return true; })()`);
const termIds = (page) => page.evaluate('window.aiw.term.list().then(l => l.filter(t => !t.exited).map(t => t.id))');
const runsApi = (page) => page.evaluate("window.aiw.request('GET','/v1/runs').then(r => r.body.runs)");

let app1, app2;
try {
  // ================================================================= 1ª ejecución
  app1 = launch(9333);
  let page = await connect(9333);
  check('la ventana carga y el Core responde', await waitFor(() => page.evaluate("document.getElementById('status').textContent.includes('conectado')")));
  const prj = await page.evaluate(`window.aiw.request('POST','/v1/projects',{path:${JSON.stringify(repo)}}).then(r=>r.body)`);
  check('proyecto añadido vía proxy', Boolean(prj && prj.id));
  await page.send('Page.reload');
  await sleep(1500);
  page = await connect(9333);
  check('la barra ofrece un panel por modelo y sesiones CLI', await waitFor(() => page.evaluate(`['terminal','agent:fake','agent:claude','agent:opencode','cli:claude','cli:opencode','notes'].every(k => document.querySelector('[data-add="'+k+'"]'))`)));
  await page.evaluate("document.getElementById('project').dispatchEvent(new Event('change'))");

  // ---- varios terminales a la vez, cada uno en su panel
  await click(page, '[data-add="terminal"]');
  await click(page, '[data-add="terminal"]');
  check('dos terminales en dos paneles', await waitFor(async () => (await countTiles(page, 'terminal')) === 2 && (await termIds(page)).length === 2));
  await sleep(2500);
  const ids = await termIds(page);
  const echo = (w) => (process.platform === 'win32' ? `echo ${w}-$(40+2)\\r` : `echo ${w}-$((40+2))\\n`);
  await page.evaluate(`window.aiw.term.input(${JSON.stringify(ids[0])}, "${echo('alfa')}")`);
  await page.evaluate(`window.aiw.term.input(${JSON.stringify(ids[1])}, "${echo('beta')}")`);
  check('cada terminal muestra su propia salida (aislados)', await waitFor(async () => {
    const a = await tileText(page, 'terminal', 0, '.xterm-rows'); const b = await tileText(page, 'terminal', 1, '.xterm-rows');
    return a.includes('alfa-42') && !a.includes('beta-42') && b.includes('beta-42') && !b.includes('alfa-42');
  }));

  // ---- dos agentes (dos "modelos") en paneles distintos
  await click(page, '[data-add="agent:fake"]');
  await click(page, '[data-add="agent:fake"]');
  check('dos paneles de agente', await waitFor(async () => (await countTiles(page, 'agent')) === 2), await page.evaluate("[...document.querySelectorAll('.tile')].map(t => t.dataset.type).join()"));
  for (const [i, text] of [[0, 'tarea del agente A'], [1, 'tarea del agente B']]) {
    await inTile(page, 'agent', i, '.agent-mode', "e.value = 'write'; e.dispatchEvent(new Event('change'))");
    await inTile(page, 'agent', i, '.agent-prompt', `e.value = ${JSON.stringify(text)}`);
    await inTile(page, 'agent', i, '.agent-send', 'e.click()');
  }
  const done = await waitFor(async () => {
    const rs = (await runsApi(page)).filter((r) => r.state === 'completed' && r.worktreePath);
    return rs.length === 2 ? rs : false;
  }, 25000);
  check('cada agente corre su propio run con su worktree', Boolean(done) && done[0].worktreePath !== done[1].worktreePath);
  const byTitle = (t) => done.find((r) => r.title === t);
  const runA = byTitle('tarea del agente A'); const runB = byTitle('tarea del agente B');
  fs.writeFileSync(path.join(runA.worktreePath, 'notas.txt'), 'linea del agente A\n');
  fs.writeFileSync(path.join(runB.worktreePath, 'notas.txt'), 'linea del agente B\n');
  check('cada panel muestra solo su run', await waitFor(async () => (await tileText(page, 'agent', 0, '.agent-out')).includes('» tarea del agente A') && !(await tileText(page, 'agent', 0, '.agent-out')).includes('agente B')));

  // ---- revisión y fusión (CA-04) desde el panel de cada agente
  check('el panel A ofrece "Revisar cambios"', await waitFor(async () => (await inTile(page, 'agent', 0, '.agent-review:not([hidden])', 'e.click()'))));
  check('se abre un panel de revisión con el diff', await waitFor(() => countTiles(page, 'review').then((n) => n === 1)) && await waitFor(async () => (await tileText(page, 'review', 0, '.review-patch')).includes('+linea del agente A')));
  await waitFor(() => page.evaluate("!document.querySelector('.tile[data-type=review] .review-merge').disabled"));
  await inTile(page, 'review', 0, '.review-merge', 'e.click()');
  check('aprobar y fusionar lleva el cambio a la rama principal', await waitFor(() => fs.existsSync(path.join(repo, 'notas.txt')) && norm(fs.readFileSync(path.join(repo, 'notas.txt'), 'utf8')) === 'linea del agente A\n', 15000));
  check('el panel B revisa y el conflicto se informa sin perder nada', await (async () => {
    await waitFor(async () => (await inTile(page, 'agent', 1, '.agent-review:not([hidden])', 'e.click()')));
    await waitFor(async () => (await countTiles(page, 'review')) === 2);
    await waitFor(() => page.evaluate("!document.querySelectorAll('.tile[data-type=review]')[1].querySelector('.review-merge').disabled"));
    await inTile(page, 'review', 1, '.review-merge', 'e.click()');
    const shown = await waitFor(async () => (await tileText(page, 'review', 1, '.review-msg')).includes('Conflicto'));
    return shown && norm(fs.readFileSync(path.join(repo, 'notas.txt'), 'utf8')) === 'linea del agente A\n'
      && norm(fs.readFileSync(path.join(runB.worktreePath, 'notas.txt'), 'utf8')) === 'linea del agente B\n'
      && execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim() === '';
  })());

  // ---- lienzo: arrastrar, redimensionar, notas
  check('los paneles nuevos se colocan sin solaparse', await page.evaluate(`(() => { const r = [...document.querySelectorAll('.tile')].map(t => ({ x: parseInt(t.style.left), y: parseInt(t.style.top), w: parseInt(t.style.width), h: parseInt(t.style.height) })); for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i], b = r[j]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false; } return true; })()`));
  const before = await rect(page, 'terminal', 0);
  await pointer(page, 'terminal', 0, '.tile-head', 120, 80);
  const moved = await rect(page, 'terminal', 0);
  check('un panel se arrastra y se ajusta a la cuadrícula', moved.x === before.x + 120 && moved.y === before.y + 80, JSON.stringify(moved));
  await pointer(page, 'agent', 0, '.tile-grip', 100, 60);
  const sized = await rect(page, 'agent', 0);
  check('un panel se redimensiona', sized.w > 0 && sized.h > 0, JSON.stringify(sized));
  await click(page, '[data-add="notes"]');
  await waitFor(async () => (await countTiles(page, 'notes')) === 1);
  await inTile(page, 'notes', 0, '.notes-area', "e.value = 'recordatorio persistente'; e.dispatchEvent(new Event('input'))");
  await sleep(1200); // el layout se guarda con un pequeño retraso
  const layoutBefore = { term0: await rect(page, 'terminal', 0), agent0: await rect(page, 'agent', 0), total: await page.evaluate("document.querySelectorAll('.tile').length") };
  if (process.env.E2E_SHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.E2E_SHOT, Buffer.from(shot.result.data, 'base64'));
  }
  check('el layout tiene los 7 paneles esperados', layoutBefore.total === 7, String(layoutBefore.total));

  // ---- cierre normal de la ventana (CA-03)
  await Promise.race([page.evaluate('window.close()'), sleep(1000)]).catch(() => {});
  page.close();
  check('la app se cierra al cerrar la ventana', await waitFor(() => app1.exitCode !== null, 10000));
  await sleep(1500);
  const tok = fs.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim();
  const coreTerms = await fetch(`http://127.0.0.1:${PORT}/v1/terminals`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json()).catch(() => ({ terminals: [] }));
  check('CA-03: el Core y los 2 terminales siguen vivos tras cerrar Electron', coreTerms.terminals.filter((t) => !t.exited).length === 2);

  // ================================================================= 2ª ejecución: restauración
  app2 = launch(9334);
  page = await connect(9334);
  check('se restauran los 7 paneles', await waitFor(async () => (await page.evaluate("document.querySelectorAll('.tile').length")) === 7));
  const after = { term0: await rect(page, 'terminal', 0), agent0: await rect(page, 'agent', 0) };
  check('se restauran posiciones y tamaños', JSON.stringify(after) === JSON.stringify({ term0: layoutBefore.term0, agent0: layoutBefore.agent0 }), JSON.stringify(after));
  check('las notas conservan su texto', await waitFor(async () => (await inTile(page, 'notes', 0, '.notes-area', "if (e.value !== 'recordatorio persistente') throw new Error('x')"))));
  check('cada terminal reconecta a SU sesión y recupera el scrollback', await waitFor(async () => {
    const a = await tileText(page, 'terminal', 0, '.xterm-rows'); const b = await tileText(page, 'terminal', 1, '.xterm-rows');
    return a.includes('alfa-42') && b.includes('beta-42') && !a.includes('beta-42') && !b.includes('alfa-42');
  }));
  check('los paneles de agente recuperan su estado y salida', await waitFor(async () => (await tileText(page, 'agent', 0, '.agent-status')).includes('completed') && (await tileText(page, 'agent', 0, '.agent-out')).includes('hola desde fake')));
  await inTile(page, 'terminal', 0, '.tile-close', 'e.click()');
  check('cerrar un panel de terminal cierra su sesión en el Core', await waitFor(async () => (await termIds(page)).length === 1 && (await countTiles(page, 'terminal')) === 1));
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
