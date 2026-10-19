// Verificación con Claude REAL (requiere `claude auth login` hecho): abre un panel "Claude Code" (adaptador)
// y un panel "Claude Code (CLI)" (sesión interactiva) en la app y comprueba que responden.
// Usa un repositorio temporal y datos aislados; consume algo de tu cuota de suscripción.
// Uso: node apps/desktop/scripts/e2e-claude.mjs   (E2E_SHOT=ruta.png guarda una captura)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = createRequire(path.join(desktop, 'package.json'))('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-claude-'));
const repo = path.join(tmp, 'repo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ' — ' + detail : ''}`); };

fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'a.txt'), 'hola mundo\n');
for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'i']]) execFileSync('git', a, { cwd: repo });

const env = { ...process.env, AIW_DATA_DIR: path.join(tmp, 'data'), AIW_PORT: '47996', AIW_RESERVE_MEM_GB: '0', AIW_MIN_FREE_DISK_GB: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electronBin, [desktop, '--remote-debugging-port=9341', `--user-data-dir=${path.join(tmp, 'u')}`], { env, stdio: 'ignore' });

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9341/json', { signal: AbortSignal.timeout(2000) })).json();
      const p = pages.find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0; const pend = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
        const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails.exception?.description ?? d.result.exceptionDetails)); return d.result.result.value; });
        return { evaluate, send };
      }
    } catch { /* aún no */ }
    await sleep(500);
  }
  throw new Error('no se pudo conectar al renderer');
}
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* reintento */ } await sleep(500); } return false; };

try {
  let page = await connect();
  await waitFor(() => page.evaluate("document.getElementById('status').textContent.includes('conectado')"));
  await page.evaluate(`window.aiw.request('POST','/v1/projects',{path:${JSON.stringify(repo)}})`);
  await page.send('Page.reload');
  await sleep(1500);
  page = await connect();
  await waitFor(() => page.evaluate("!!document.querySelector('[data-add=\"agent:claude\"]') && !!document.getElementById('project').value"));
  await page.evaluate("document.getElementById('project').dispatchEvent(new Event('change'))");

  // ---- panel del adaptador (claude -p stream-json)
  await page.evaluate("document.querySelector('[data-add=\"agent:claude\"]').click()");
  await waitFor(() => page.evaluate("!!document.querySelector('.tile[data-type=agent]')"));
  await page.evaluate("(() => { const t = document.querySelector('.tile[data-type=agent]'); t.querySelector('.agent-prompt').value = 'Lee a.txt con la herramienta Read y dime su contenido en una frase.'; t.querySelector('.agent-send').click(); })()");
  const st = await waitFor(async () => { const s = await page.evaluate("document.querySelector('.tile[data-type=agent] .agent-status').textContent"); return ['completed', 'failed', 'interrupted', 'cancelled'].includes(s) ? s : false; }, 120000);
  const out = await page.evaluate("document.querySelector('.tile[data-type=agent] .agent-out').textContent");
  check('panel Claude Code: el run termina completed', st === 'completed', `${st} | ${JSON.stringify(out).slice(0, 300)}`);
  check('panel Claude Code: muestra la herramienta Read y el contenido real', out.includes('▶ Read') && out.includes('hola mundo'));

  // ---- panel CLI interactivo
  await page.evaluate("document.querySelector('[data-add=\"cli:claude\"]').click()");
  const screen = () => page.evaluate("document.querySelector('.tile[data-type=terminal] .xterm-rows')?.innerText ?? ''");
  const termId = async () => (await page.evaluate('window.aiw.term.list().then(l => l.filter(t => !t.exited).map(t => t.id))')).at(-1);
  await waitFor(async () => termId(), 15000);
  const TUI = /Welcome to Claude Code|Claude Code v\d|\? for shortcuts|text style|\/theme|trust (the files|this folder)/i;
  let trusted = false;
  const ready = await waitFor(async () => {
    const s = await screen();
    if (!trusted && /trust/i.test(s)) { trusted = true; await page.evaluate(`window.aiw.term.input(${JSON.stringify(await termId())}, '\\r')`); } // carpeta temporal creada por esta prueba
    return TUI.test(s); // marcas propias de la interfaz de Claude; un prompt de PowerShell no cuenta
  }, 60000);
  await sleep(3000); // debe seguir visible (que no haya salido de vuelta a PowerShell)
  const stable = TUI.test(await screen()) && !/PS C:\\.*>\s*$/m.test(await screen());
  check('panel Claude Code (CLI): arranca la interfaz interactiva real en su propio terminal y se mantiene', Boolean(ready) && stable, (await screen()).replace(/\s+/g, ' ').slice(0, 160));
  // Primer uso de `claude` interactivo: pide elegir tema. Elegirlo cambiaría la configuración global del
  // usuario, así que no se toca: se informa y se omite la prueba de prompt.
  const settled = await waitFor(async () => /text style|\/theme|Choose the text|\? for shortcuts/i.test(await screen()), 30000);
  const onboarding = !/\? for shortcuts/i.test(await screen());
  if (!settled || onboarding) console.log('AVISO el CLI muestra su asistente de primer uso (tema) y la prueba de prompt se omite: complétalo una vez en el panel y repite esta prueba.');
  if (ready && settled && !onboarding) {
    await page.evaluate(`window.aiw.term.input(${JSON.stringify(await termId())}, 'Responde solo con la palabra: LISTO42')`);
    await sleep(500);
    await page.evaluate(`window.aiw.term.input(${JSON.stringify(await termId())}, '\\r')`);
    const answered = await waitFor(async () => { const sc = await screen(); return TUI.test(sc) && !/PS C:\\/.test(sc) && (sc.match(/LISTO42/g) ?? []).length >= 2; }, 90000);
    check('panel Claude Code (CLI): responde a un prompt real', Boolean(answered));
  }
  if (process.env.E2E_SHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.E2E_SHOT, Buffer.from(shot.result.data, 'base64'));
  }
} catch (e) {
  check('ejecución sin excepciones', false, String(e.message || e));
} finally {
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* cerrado */ }
  try {
    const pids = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'services.core.src.main' -and $_.CommandLine -notmatch 'Get-Cim' } | % { $_.ProcessId }`]).toString().trim().split(/\s+/).filter(Boolean);
    for (const p of pids) process.kill(Number(p));
  } catch { /* nada */ }
  await sleep(1000);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temporal */ }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
