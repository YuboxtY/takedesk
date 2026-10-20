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
import http from 'node:http';

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
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'README.md'), '# Proyecto de prueba\n');
fs.writeFileSync(path.join(repo, 'src', 'hello.js'), 'console.log("hola");\n');
for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'i']]) execFileSync('git', a, { cwd: repo });

// imagen de fondo sembrada en la carpeta de datos de la app (el diálogo nativo de archivos no se puede automatizar)
const SEED_IMG = 'abcdef0123456789.png';
fs.mkdirSync(path.join(userData, 'backgrounds'), { recursive: true });
fs.writeFileSync(path.join(userData, 'backgrounds', SEED_IMG), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

// servidor web local para probar el panel Navegador
const web = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(p === '/two' ? '<title>Dos</title><h1>dos</h1>' : '<title>Hola E2E</title><a id="l" target="_blank" href="/two">abrir</a>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEBPORT = web.address().port;

const env = { ...process.env, AIW_DATA_DIR: dataDir, AIW_PORT: String(PORT), AIW_ENABLE_FAKE: '1', AIW_RESERVE_MEM_GB: '0', AIW_MIN_FREE_DISK_GB: '0', AIW_APPS_DRYRUN: '1' }; // DRYRUN: las apps externas no se abren de verdad en la prueba
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
  // esperar a que ambos shells muestren su prompt (en vez de una espera fija: el arranque de PowerShell varía con la carga)
  await waitFor(async () => (await tileText(page, 'terminal', 0, '.xterm-rows')).includes('PS ') && (await tileText(page, 'terminal', 1, '.xterm-rows')).includes('PS '), 30000);
  // teclear como un usuario: enfocar el xterm de CADA panel y enviar teclas reales (el orden de las sesiones del Core
  // no tiene por qué coincidir con el orden de los paneles)
  const typeIn = async (i, text) => {
    await page.evaluate(`${tiles('terminal')}[${i}].querySelector('.xterm-helper-textarea').focus()`);
    await page.send('Input.insertText', { text });
    for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'rawKeyDown' ? '\r' : undefined });
  };
  const echo = (w) => (process.platform === 'win32' ? `echo ${w}-$(40+2)` : `echo ${w}-$((40+2))`);
  await typeIn(0, echo('alfa'));
  await typeIn(1, echo('beta'));
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
  check('el layout tiene los 7 paneles esperados', layoutBefore.total === 7, `${layoutBefore.total}: ` + await page.evaluate("[...document.querySelectorAll('.tile')].map(t => t.dataset.type + ':' + t.querySelector('.tile-title').textContent).join(' | ')"));

  // ---- espacios y atajos de teclado
  const key = (code, m = {}) => page.evaluate(`(() => { const e = new KeyboardEvent('keydown', { code: ${JSON.stringify(code)}, key: ${JSON.stringify(code)}, bubbles: true, cancelable: true, ctrlKey: ${!!m.ctrl}, shiftKey: ${!!m.shift}, altKey: ${!!m.alt} }); document.body.dispatchEvent(e); return e.defaultPrevented; })()`);
  const visibleCount = () => page.evaluate("[...document.querySelectorAll('.tile')].filter(t => t.offsetParent !== null).length");
  const tabs = () => page.evaluate("[...document.querySelectorAll('.space-tab')].map(t => ({ name: t.querySelector('.space-name, .space-rename')?.textContent || '', active: t.classList.contains('active'), count: t.querySelector('.space-count').textContent }))");
  const totalCount = () => page.evaluate("document.querySelectorAll('.tile').length");
  check('hay un único espacio con los 7 paneles visibles', (await tabs()).length === 1 && (await visibleCount()) === 7);
  check('Ctrl+Shift+S crea un espacio vacío y lo activa', (await key('KeyS', { ctrl: true, shift: true })) && await waitFor(async () => { const t = await tabs(); return t.length === 2 && t[1].active && (await visibleCount()) === 0; }));
  check('Ctrl+Shift+N crea una nota solo en el espacio activo', (await key('KeyN', { ctrl: true, shift: true })) && await waitFor(async () => (await visibleCount()) === 1 && (await totalCount()) === 8 && (await tabs()).map((t) => t.count).join() === '7,1'));
  await page.evaluate("document.querySelectorAll('.tile[data-type=notes] .notes-area')[1].value = 'nota del espacio 2'; document.querySelectorAll('.tile[data-type=notes] .notes-area')[1].dispatchEvent(new Event('input'))");
  // renombrar con doble clic
  await page.evaluate("document.querySelectorAll('.space-tab')[1].querySelector('.space-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await page.evaluate("(() => { const i = document.querySelector('.space-rename'); i.value = 'Docs'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
  check('doble clic renombra el espacio', await waitFor(async () => (await tabs())[1]?.name === 'Docs'));
  check('Ctrl+Alt+1 vuelve al espacio 1 con sus 7 paneles (los terminales siguen vivos ocultos)', (await key('Digit1', { ctrl: true, alt: true })) && await waitFor(async () => (await tabs())[0].active && (await visibleCount()) === 7) && (await termIds(page)).length === 2);
  check('Ctrl+Alt+→ y ← cambian de espacio', (await key('ArrowRight', { ctrl: true, alt: true })) && await waitFor(async () => (await tabs())[1].active) && (await key('ArrowLeft', { ctrl: true, alt: true })) && await waitFor(async () => (await tabs())[0].active));
  const focusedId = () => page.evaluate("document.querySelector('.tile.focused')?.dataset.tileId ?? ''");
  const f0 = await focusedId();
  await key('ArrowDown', { ctrl: true, alt: true });
  const f1 = await focusedId();
  await key('ArrowUp', { ctrl: true, alt: true });
  check('Ctrl+Alt+↑/↓ mueven el foco entre paneles', f0 !== '' && f1 !== '' && f0 !== f1 && (await focusedId()) === f0);
  await key('KeyN', { ctrl: true, shift: true });
  await waitFor(async () => (await totalCount()) === 9);
  check('Ctrl+Shift+W cierra el panel enfocado', (await key('KeyW', { ctrl: true, shift: true })) && await waitFor(async () => (await totalCount()) === 8));
  await key('F1');
  check('F1 muestra la ayuda de atajos y Escape la cierra', (await page.evaluate("!document.getElementById('help').hidden && document.getElementById('help').textContent.includes('Ctrl+Shift+T')")) && (await key('Escape')) === false && await waitFor(() => page.evaluate("document.getElementById('help').hidden")));
  // ---- zoom y paneo del lienzo infinito
  const vp = "document.getElementById('canvas-scroll')";
  const cam = () => page.evaluate(`(() => { const v = ${vp}; return { x: parseFloat(v.style.getPropertyValue('--vx')), y: parseFloat(v.style.getPropertyValue('--vy')), k: parseFloat(v.style.getPropertyValue('--vk')), label: document.getElementById('zoom-label').textContent }; })()`);
  const vrect = () => page.evaluate(`(() => { const r = ${vp}.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
  const wheel = (dx, dy, ctrl, cx, cy) => page.evaluate(`${vp}.dispatchEvent(new WheelEvent('wheel', { deltaX: ${dx}, deltaY: ${dy}, ctrlKey: ${ctrl}, clientX: ${cx}, clientY: ${cy}, bubbles: true, cancelable: true }))`);
  await click(page, '#zoom-reset');
  await sleep(200);
  const c0 = await cam(); const vr = await vrect();
  check('el zoom parte en 100 %', c0.k === 1 && c0.label === '100 %', JSON.stringify(c0));
  const cx = vr.left + 600, cy = vr.top + 300;
  await wheel(0, -300, true, cx, cy);
  const c1 = await cam();
  const w0x = (cx - vr.left - c0.x) / c0.k; const w1x = (cx - vr.left - c1.x) / c1.k;
  check('Ctrl+rueda acerca y mantiene fijo el punto bajo el cursor', c1.k > 1 && Math.abs(w0x - w1x) < 0.5, `k=${c1.k.toFixed(2)}`);
  await wheel(0, 100, false, cx, cy);
  const c2 = await cam();
  check('la rueda sobre el fondo desplaza el lienzo', Math.abs(c2.y - (c1.y - 100)) < 0.5 && c2.k === c1.k);
  await page.evaluate(`(() => { const v = ${vp}; const o = (x, y) => ({ bubbles: true, button: 0, clientX: x, clientY: y }); v.dispatchEvent(new PointerEvent('pointerdown', o(300, 600))); window.dispatchEvent(new PointerEvent('pointermove', o(350, 630))); window.dispatchEvent(new PointerEvent('pointerup', o(350, 630))); })()`);
  const c3 = await cam();
  check('arrastrar el fondo desplaza el lienzo', Math.abs(c3.x - (c2.x + 50)) < 0.5 && Math.abs(c3.y - (c2.y + 30)) < 0.5);
  await click(page, '#zoom-reset'); await sleep(200);
  await click(page, '#zoom-out'); await sleep(200);
  const c4 = await cam();
  check('el botón − aleja y el botón 100 % restablece', c4.k < 1 && c4.label.endsWith('%'));
  await key('Equal', { ctrl: true, alt: true });
  const c5 = await cam();
  check('Ctrl+Alt++ acerca', c5.k > c4.k);
  await key('Digit0', { ctrl: true, alt: true });
  check('Ctrl+Alt+0 vuelve al 100 %', (await cam()).k === 1);
  await key('Minus', { ctrl: true, alt: true }); await key('Minus', { ctrl: true, alt: true });
  const kz = (await cam()).k;
  const tBefore = await rect(page, 'terminal', 0);
  await pointer(page, 'terminal', 0, '.tile-head', 100, 0);
  const tAfter = await rect(page, 'terminal', 0);
  const expectedX = Math.round((tBefore.x + 100 / kz) / 10) * 10;
  check('arrastrar un panel con zoom respeta la escala', kz < 1 && tAfter.x === expectedX, `k=${kz.toFixed(2)} x ${tBefore.x}→${tAfter.x} (esperado ${expectedX})`);
  await click(page, '#zoom-fit'); await sleep(300);
  const fit = await cam(); const fr = await vrect();
  const inside = await page.evaluate(`[...document.querySelectorAll('.tile')].filter(t => t.offsetParent !== null).every(t => { const r = t.getBoundingClientRect(); return r.left >= ${fr.left} - 2 && r.top >= ${fr.top} - 2 && r.right <= ${fr.left + fr.w} + 2 && r.bottom <= ${fr.top + fr.h} + 2; })`);
  check('Ajustar deja todos los paneles visibles a la vez', inside && fit.k <= 1, `k=${fit.k.toFixed(2)}`);
  globalThis.savedK = fit.k;
  if (process.env.E2E_SHOT) fs.writeFileSync(process.env.E2E_SHOT.replace('.png', '-fit.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  layoutBefore.term0 = await rect(page, 'terminal', 0); // el arrastre con zoom movió este panel a propósito
  layoutBefore.agent0 = await rect(page, 'agent', 0);
  // ---- apariencia: fondo por espacio y tema
  const bgClass = () => page.evaluate("[...document.getElementById('canvas-scroll').classList].find(c => c.startsWith('bg-')) || ''");
  const bgImage = () => page.evaluate("getComputedStyle(document.getElementById('canvas-scroll')).backgroundImage");
  await click(page, '#bg-btn');
  check('el menú de fondo se abre', await waitFor(() => page.evaluate("!document.getElementById('bg-menu').hidden")));
  await click(page, '[data-bg-kind="grid"]');
  check('Cuadrícula cambia el fondo', await waitFor(async () => (await bgClass()) === 'bg-grid'));
  await click(page, '[data-bg-kind="gradient"]');
  await waitFor(() => page.evaluate("!!document.querySelector('[data-bg-gradient=\"ocean\"]')"));
  await click(page, '[data-bg-gradient="ocean"]');
  check('el degradado Océano se aplica', await waitFor(async () => (await bgClass()) === 'bg-gradient' && (await bgImage()).includes('rgb(3, 27, 52)')));
  await click(page, '[data-bg-kind="image"]');
  check('las imágenes guardadas aparecen como opciones', await waitFor(() => page.evaluate(`!!document.querySelector('[data-bg-image="${SEED_IMG}"]')`)));
  await click(page, `[data-bg-image="${SEED_IMG}"]`);
  check('una imagen como fondo (data URL local, sin rutas del disco)', await waitFor(async () => (await bgClass()) === 'bg-image' && (await bgImage()).includes('data:image/png')));
  await page.evaluate("(() => { const c = document.querySelector('.bg-color'); c.value = '#202040'; c.dispatchEvent(new Event('input', { bubbles: true })); })()");
  check('el color base se aplica', await waitFor(() => page.evaluate("document.getElementById('canvas-scroll').style.getPropertyValue('--bgc') === '#202040'")));
  await page.evaluate("(() => { const s = document.querySelector('.theme-select'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  check('el tema claro cambia los colores de la aplicación', await waitFor(() => page.evaluate("document.documentElement.getAttribute('data-theme') === 'light' && getComputedStyle(document.body).backgroundColor === 'rgb(244, 245, 247)'")));
  check('con tema claro las apps (terminal, agente) conservan su aspecto oscuro', await page.evaluate("['terminal', 'agent'].every(t => getComputedStyle(document.querySelector('.tile[data-type=' + t + ']')).backgroundColor === 'rgb(22, 27, 34)') && getComputedStyle(document.querySelector('.tile[data-type=notes]')).backgroundColor !== 'rgb(22, 27, 34)'"));
  check('"＋ Mi imagen…" está siempre visible en el menú de fondo', await page.evaluate("!!document.querySelector('#bg-menu .bg-myimage')"));
  check('el catálogo incluye los degradados nuevos', await page.evaluate("(() => { document.querySelector('[data-bg-kind=gradient]').click(); return true; })()") && await waitFor(() => page.evaluate("['nebula','forest','ember'].every(id => document.querySelector('[data-bg-gradient=\"' + id + '\"]'))")));
  await click(page, '[data-bg-kind="image"]');
  await click(page, `[data-bg-image="${SEED_IMG}"]`);
  await key('Escape');
  check('Escape cierra el menú', await waitFor(() => page.evaluate("document.getElementById('bg-menu').hidden")));
  await key('Digit2', { ctrl: true, alt: true });
  check('cada espacio tiene su propio fondo (el 2 sigue con puntos)', await waitFor(async () => (await bgClass()) === 'bg-dots'));
  await key('Digit1', { ctrl: true, alt: true });
  check('al volver al espacio 1 regresa su imagen', await waitFor(async () => (await bgClass()) === 'bg-image'));
  // ---- navegador con pestañas (webview aislado)
  const brTabs = () => page.evaluate("[...document.querySelectorAll('.tile[data-type=browser] .br-tab')].map(t => ({ title: t.querySelector('.br-tab-title').textContent, active: t.classList.contains('active') }))");
  const brGo = (u) => page.evaluate(`(() => { const i = document.querySelector('.tile[data-type=browser] .br-url'); i.value = ${JSON.stringify(u)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  const activeView = "[...document.querySelectorAll('.tile[data-type=browser] webview')].filter(v => v.style.display !== 'none')[0]";
  await click(page, '[data-add="browser"]');
  check('se abre un panel de navegador con una pestaña', await waitFor(async () => (await countTiles(page, 'browser')) === 1 && (await brTabs()).length === 1));
  await brGo(`127.0.0.1:${WEBPORT}/`);
  check('navega a una página local y muestra su título en la pestaña', await waitFor(async () => (await brTabs())[0]?.title === 'Hola E2E'));
  check('la página corre en un webview con perfil propio', await page.evaluate(`(() => { const v = ${activeView}; return v.getAttribute('partition') === 'persist:aiw-browser' && v.getURL().startsWith('http://127.0.0.1'); })()`));
  check('un enlace target=_blank se abre como pestaña nueva del mismo panel', await waitFor(async () => { await page.evaluate(`${activeView}.executeJavaScript("document.getElementById('l').click()")`); return true; }) && await waitFor(async () => { const t = await brTabs(); return t.length === 2 && t[1].active && t[1].title === 'Dos'; }));
  await brGo('file:///C:/Windows/win.ini');
  check('file: se rechaza en la barra de direcciones', await waitFor(() => page.evaluate("!document.querySelector('.tile[data-type=browser] .br-msg').hidden")));
  await brGo('javascript:alert(1)');
  await page.evaluate(`${activeView}.executeJavaScript("location.href = 'file:///C:/Windows/win.ini'")`);
  await sleep(1500);
  check('ni la barra ni la propia página pueden llevar el webview a file: o javascript:', (await page.evaluate(`${activeView}.getURL()`)).startsWith('http://127.0.0.1') && (await brTabs()).length === 2);
  await page.evaluate("document.querySelectorAll('.tile[data-type=browser] .br-tab')[0].click()");
  check('cambiar de pestaña muestra la otra página', await waitFor(async () => (await brTabs())[0].active) && (await page.evaluate(`${activeView}.getURL()`)).endsWith('/'));
  // ---- editor (Monaco) y archivos del proyecto
  const edTabs = () => page.evaluate("[...document.querySelectorAll('.tile[data-type=editor] .ed-tab')].map(t => ({ name: t.querySelector('.ed-tab-name').textContent, active: t.classList.contains('active') }))");
  const treeNames = () => page.evaluate("[...document.querySelectorAll('.tile[data-type=editor] .ed-node')].map(n => n.dataset.type + ':' + n.dataset.path)");
  const ctrlS = async () => { for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 }); };
  const helloPath = path.join(repo, 'src', 'hello.js');
  await click(page, '[data-add="editor"]');
  check('el explorador lista carpetas y archivos del proyecto (sin .git)', await waitFor(async () => { const n = await treeNames(); return n.includes('dir:src') && n.includes('file:README.md') && !n.some((x) => x.includes('.git')); }));
  await click(page, '.tile[data-type=editor] .ed-node[data-path="README.md"]');
  check('abrir un archivo lo muestra en Monaco con su contenido', await waitFor(async () => (await page.evaluate("window.monaco ? window.monaco.editor.getModels().map(m => m.getValue()).join('|') : ''")).includes('# Proyecto de prueba') && (await edTabs())[0]?.name === 'README.md', 60000));
  await click(page, '.tile[data-type=editor] .ed-node[data-path="src"]');
  await waitFor(() => page.evaluate("!!document.querySelector('.tile[data-type=editor] .ed-node[data-path=\"src/hello.js\"]')"));
  await click(page, '.tile[data-type=editor] .ed-node[data-path="src/hello.js"]');
  check('el lenguaje se detecta por extensión (javascript)', await waitFor(() => page.evaluate("window.monaco.editor.getModels().some(m => m.getLanguageId() === 'javascript')")));
  await page.evaluate("(() => { const ed = window.monaco.editor.getEditors()[0]; ed.focus(); ed.trigger('e2e', 'type', { text: '// editado\\n' }); })()");
  check('editar marca el archivo como modificado (●)', await waitFor(async () => (await edTabs()).some((t) => t.name.includes('●'))));
  await ctrlS();
  check('Ctrl+S guarda en disco y quita la marca', await waitFor(() => norm(fs.readFileSync(helloPath, 'utf8')).startsWith('// editado\n')) && await waitFor(async () => !(await edTabs()).some((t) => t.name.includes('●'))));
  // conflicto: el archivo cambia en disco mientras está abierto
  const later = new Date(Date.now() + 120000);
  fs.writeFileSync(helloPath, 'externo\n'); fs.utimesSync(helloPath, later, later);
  await page.evaluate("(() => { const ed = window.monaco.editor.getEditors()[0]; ed.focus(); ed.trigger('e2e', 'type', { text: '// mío\\n' }); })()");
  await ctrlS();
  check('si el archivo cambió en disco, avisa y no lo pisa', await waitFor(async () => (await tileText(page, 'editor', 0, '.ed-status')).includes('cambió en disco')) && norm(fs.readFileSync(helloPath, 'utf8')) === 'externo\n');
  await click(page, '.tile[data-type=editor] .ed-reload');
  check('"Recargar del disco" trae la versión externa al editor', await waitFor(() => page.evaluate("window.monaco.editor.getEditors()[0].getValue().replaceAll('\\r\\n', '\\n') === 'externo\\n'")));
  const pid = JSON.stringify(prj.id);
  const bad = await page.evaluate(`Promise.all([window.aiw.files.read(${pid}, '../../Windows/win.ini'), window.aiw.files.read(${pid}, ${JSON.stringify('C:\\Windows\\win.ini')}), window.aiw.files.write(${pid}, '.git/config', 'x'), window.aiw.files.list(${pid}, '..'), window.aiw.files.read('prj_inexistente', 'README.md')])`);
  check('el renderer no puede leer ni escribir fuera del proyecto ni en .git', bad.every((r) => r.ok === false) && bad.slice(0, 4).map((r) => r.code).join() === 'outside,outside,forbidden,outside', bad.map((r) => r.code).join());
  // ---- apps del equipo (lista cerrada; en la prueba no se abren de verdad)
  await click(page, '[data-add="apps"]');
  check('el panel Apps ofrece las apps del equipo', await waitFor(() => page.evaluate("!!document.querySelector('.tile[data-type=apps] [data-app=explorer]:not([disabled])') && !!document.querySelector('.tile[data-type=apps] [data-app=vscode]')")));
  await click(page, '.tile[data-type=apps] [data-app=explorer]');
  check('lanzar una app informa el resultado', await waitFor(async () => (await tileText(page, 'apps', 0, '.apps-msg')).includes('Abierto: Explorador')));
  const appLaunch = (id, p = pid) => page.evaluate(`window.aiw.apps.launch(${JSON.stringify(id)}, ${p})`);
  const ex = await appLaunch('explorer');
  check('el comando es fijo y su único argumento es la raíz del proyecto', ex.ok && ex.dryRun.exe.toLowerCase().endsWith('explorer.exe') && ex.dryRun.args.length === 1 && ex.dryRun.args[0].toLowerCase() === fs.realpathSync.native(repo).toLowerCase(), JSON.stringify(ex.dryRun));
  const bad2 = [await appLaunch('calc'), await appLaunch('cmd'), await appLaunch('explorer;calc'), await appLaunch('..\explorer'), await appLaunch('explorer', JSON.stringify('prj_inexistente'))];
  check('no se puede lanzar nada fuera de la lista ni en proyectos inexistentes', bad2.every((r) => r.ok === false));
  await sleep(1200); // guardado del layout con espacios y de la cámara

  // ---- cierre normal de la ventana (CA-03)
  await Promise.race([page.evaluate('window.close()'), sleep(1000)]).catch(() => {});
  page.close();
  const t0close = Date.now();
  check('la app se cierra al cerrar la ventana', await waitFor(() => app1.exitCode !== null, 10000), `${Date.now() - t0close} ms`);
  await sleep(1500);
  const tok = fs.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim();
  const coreTerms = await fetch(`http://127.0.0.1:${PORT}/v1/terminals`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json()).catch(() => ({ terminals: [] }));
  check('CA-03: el Core y los 2 terminales siguen vivos tras cerrar Electron', coreTerms.terminals.filter((t) => !t.exited).length === 2);

  // ================================================================= 2ª ejecución: restauración
  app2 = launch(9334);
  page = await connect(9334);
  check('se restauran los 11 paneles (7 + nota del espacio 2 + navegador + editor + apps)', await waitFor(async () => (await page.evaluate("document.querySelectorAll('.tile').length")) === 11));
  check('el editor restaura sus archivos abiertos', await waitFor(async () => { const t = await edTabs(); return t.length === 2 && t.some((x) => x.name.startsWith('README.md')) && t.some((x) => x.name.startsWith('hello.js')); }, 60000), JSON.stringify(await edTabs()));
  check('el navegador restaura sus pestañas (y recarga sus páginas)', await waitFor(async () => { const t = await brTabs(); return t.length === 2 && t[0].title === 'Hola E2E' && t[1].title === 'Dos' && t[0].active; }), JSON.stringify(await brTabs()));
  check('se restauran los espacios, su nombre y el espacio activo', await waitFor(async () => { const t = await tabs(); return t.length === 2 && t[0].name === 'Espacio 1' && t[1].name === 'Docs' && t[0].active && (await visibleCount()) === 10; }));
  check('la cámara (zoom y posición) del espacio se restaura', await waitFor(async () => Math.abs((await cam()).k - globalThis.savedK) < 0.01), `${(await cam()).label}`);
  check('el fondo (imagen) y el tema claro se restauran tras reabrir', await waitFor(async () => (await bgClass()) === 'bg-image' && (await page.evaluate("document.documentElement.getAttribute('data-theme')")) === 'light'));
  await key('Digit2', { ctrl: true, alt: true });
  check('el espacio 2 conserva su nota con texto', await waitFor(async () => (await visibleCount()) === 1 && (await inTile(page, 'notes', 1, '.notes-area', "if (e.value !== 'nota del espacio 2') throw new Error('x')"))));
  await key('Digit1', { ctrl: true, alt: true });
  await waitFor(async () => (await visibleCount()) === 10);
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
  // cerrar un espacio con paneles pide confirmación (segundo clic) y quita sus paneles
  await page.evaluate("document.querySelectorAll('.space-tab')[1].querySelector('.space-close').click()");
  check('cerrar un espacio con paneles pide confirmar', await waitFor(async () => (await page.evaluate("document.querySelector('.space-close.armed')?.textContent ?? ''")).includes('¿Cerrar')) && (await tabs()).length === 2);
  await page.evaluate("document.querySelector('.space-close.armed').click()");
  check('al confirmar se cierra el espacio y sus paneles', await waitFor(async () => (await tabs()).length === 1 && (await totalCount()) === 9), `${(await tabs()).length} espacios, ${await totalCount()} paneles`);
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
  try { web.close(); } catch { /* ya cerrado */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temporal */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
