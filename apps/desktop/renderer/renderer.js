'use strict';
// Sin innerHTML con datos del Core: todo se inserta con textContent (los prompts y la salida
// de los agentes son contenido no confiable).
const $ = (id) => document.getElementById(id);
const api = window.aiw;
let adapters = [];
let selectedRun = null;
let sinceSeq = 0;

function setMsg(el, text, bad) {
  el.textContent = text || '';
  el.classList.toggle('bad', Boolean(bad));
}
const errText = (r) => (r.body && r.body.error ? r.body.error.message : `Error ${r.status}`);

async function loadHealth() {
  const r = await api.request('GET', '/v1/health');
  const el = $('status');
  if (r.status === 200 && r.body && r.body.ok) {
    el.textContent = `Core ${r.body.serverVersion} · conectado`;
    el.className = 'badge ok';
  } else {
    el.textContent = 'Core no disponible';
    el.className = 'badge bad';
  }
}

async function loadAdapters() {
  const r = await api.request('GET', '/v1/capabilities');
  adapters = r.status === 200 ? r.body.adapters : [];
  const sel = $('adapter');
  sel.replaceChildren(...adapters.map((a) => Object.assign(document.createElement('option'), { value: a.id, textContent: a.displayName })));
  updatePolicy();
}

function updatePolicy() {
  const a = adapters.find((x) => x.id === $('adapter').value);
  $('policy-row').hidden = !(a && a.dataPolicy === 'may-train');
}

async function loadProjects(selectId) {
  const r = await api.request('GET', '/v1/projects');
  const list = r.status === 200 ? r.body.projects : [];
  const sel = $('project');
  sel.replaceChildren(...list.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name + ' — ' + p.rootPath })));
  if (selectId) sel.value = selectId;
}

async function addProject() {
  const folder = await api.pickFolder();
  if (!folder) return;
  const r = await api.request('POST', '/v1/projects', { path: folder });
  if (r.status === 200 || r.status === 201) {
    setMsg($('project-msg'), 'Proyecto añadido.');
    await loadProjects(r.body.id);
  } else {
    setMsg($('project-msg'), errText(r), true);
  }
}

async function startRun() {
  const body = {
    projectId: $('project').value,
    adapter: $('adapter').value,
    prompt: $('prompt').value.trim(),
    mode: $('mode').value,
    acceptDataPolicy: $('policy').checked || undefined,
  };
  if (!body.projectId) return setMsg($('run-msg'), 'Añade un proyecto primero.', true);
  if (!body.prompt) return setMsg($('run-msg'), 'Escribe una instrucción.', true);
  const r = await api.request('POST', '/v1/runs', body);
  if (r.status === 201) {
    setMsg($('run-msg'), 'Run creado.');
    $('prompt').value = '';
    await loadRuns();
    selectRun(r.body.id, r.body.title || r.body.adapter);
  } else {
    setMsg($('run-msg'), errText(r), true);
  }
}

async function loadRuns() {
  const r = await api.request('GET', '/v1/runs');
  const rows = (r.status === 200 ? r.body.runs : []).map((run) => {
    const tr = document.createElement('tr');
    for (const v of [run.state, run.adapter, run.mode, run.title || '']) tr.appendChild(Object.assign(document.createElement('td'), { textContent: v }));
    const td = document.createElement('td');
    if (['queued', 'starting', 'running', 'waiting_approval'].includes(run.state)) {
      const b = Object.assign(document.createElement('button'), { textContent: 'Cancelar' });
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.request('POST', `/v1/runs/${run.id}/cancel`);
        loadRuns();
      });
      td.appendChild(b);
    }
    tr.appendChild(td);
    tr.addEventListener('click', () => selectRun(run.id, run.title || run.adapter));
    return tr;
  });
  $('runs').replaceChildren(...rows);
}

function selectRun(id, title) {
  selectedRun = id;
  sinceSeq = 0;
  if (typeof saveWorkspace === 'function') saveWorkspace();
  $('out-title').textContent = '· ' + title;
  $('output').textContent = '';
  pollOutput();
}

function eventText(e) {
  switch (e.kind) {
    case 'output.delta': return e.text;
    case 'tool.started': return `\n▶ ${e.name}\n`;
    case 'tool.finished': return `${e.ok ? '✔' : '✘'} ${e.summary ? e.summary.split('\n')[0] : ''}\n`;
    case 'error': return `\n[error] ${e.message}\n`;
    case 'run.finished': return `\n— terminó: ${e.ok ? 'ok' : 'con fallo'}${e.reason ? ' (' + e.reason + ')' : ''}\n`;
    default: return '';
  }
}

async function pollOutput() {
  if (!selectedRun) return;
  const id = selectedRun;
  const r = await api.request('GET', `/v1/runs/${id}/events?since=${sinceSeq}&limit=200`);
  if (id !== selectedRun) return;
  if (r.status === 200) {
    const out = $('output');
    for (const rec of r.body.events) {
      sinceSeq = Math.max(sinceSeq, rec.seq);
      out.textContent += eventText(rec.event);
    }
    out.scrollTop = out.scrollHeight;
  } else if (r.status === 410) {
    $('output').textContent = errText(r);
  }
}

// ------------------------------------------------------------ terminal (xterm + puente IPC)
let xt = null;
let currentTerm = null;

function ensureXterm() {
  if (xt) return xt;
  xt = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Consolas, "Cascadia Mono", monospace', theme: { background: '#0d1117' } });
  xt.open($('term'));
  xt.onData((d) => currentTerm && api.term.input(currentTerm, d));
  xt.onResize(({ cols, rows }) => currentTerm && api.term.resize(currentTerm, cols, rows));
  return xt;
}

async function refreshTerminals(selectId) {
  const list = await api.term.list().catch(() => []);
  const sel = $('term-select');
  sel.replaceChildren(...list.filter((t) => !t.exited).map((t) => Object.assign(document.createElement('option'), { value: t.id, textContent: t.id })));
  if (selectId && [...sel.options].some((o) => o.value === selectId)) sel.value = selectId;
  return sel.value || null;
}

async function showTerminal(id) {
  const t = ensureXterm();
  t.reset();
  currentTerm = id;
  $('term-title').textContent = id ? '· ' + id : '';
  if (id) {
    await api.term.attach(id); // el Core reenvía el scrollback al reconectar
    t.focus();
    api.term.resize(id, t.cols, t.rows);
  }
  saveWorkspace();
}

async function newTerminal() {
  const projectId = $('project').value;
  if (!projectId) return setMsg($('term-msg'), 'Añade un proyecto primero.', true);
  const t = ensureXterm();
  try {
    const info = await api.term.open(projectId, t.cols, t.rows);
    setMsg($('term-msg'), '');
    await refreshTerminals(info.id);
    await showTerminal(info.id);
  } catch (e) {
    setMsg($('term-msg'), String(e.message || e), true);
  }
}

async function killTerminal() {
  const id = $('term-select').value;
  if (!id) return;
  await api.term.kill(id);
  const next = await refreshTerminals();
  await showTerminal(next);
}

api.term.onData((id, data) => { if (id === currentTerm && xt) xt.write(data); });
api.term.onExit((id, code) => { if (id === currentTerm && xt) xt.write(`\r\n[el terminal terminó con código ${code}]\r\n`); });
$('term-new').addEventListener('click', newTerminal);
$('term-kill').addEventListener('click', killTerminal);
$('term-select').addEventListener('change', () => showTerminal($('term-select').value || null));

// ------------------------------------------------------------ workspace
function saveWorkspace() {
  api.workspace.save({
    projectId: $('project').value || undefined,
    runId: selectedRun || undefined,
    terminalId: currentTerm || undefined,
    adapter: $('adapter').value || undefined,
    mode: $('mode').value || undefined,
  });
}

async function restoreWorkspace() {
  const w = await api.workspace.load();
  if (w.projectId && [...$('project').options].some((o) => o.value === w.projectId)) $('project').value = w.projectId;
  if (w.adapter && [...$('adapter').options].some((o) => o.value === w.adapter)) $('adapter').value = w.adapter;
  if (w.mode) $('mode').value = w.mode;
  updatePolicy();
  if (w.runId) selectRun(w.runId, w.runId);
  // CA-03: si el terminal sigue vivo en el Core, se reconecta con su scrollback.
  const id = await refreshTerminals(w.terminalId);
  if (id) await showTerminal(id);
}
for (const id of ['project', 'adapter', 'mode']) $(id).addEventListener('change', saveWorkspace);

$('add-project').addEventListener('click', addProject);
$('start').addEventListener('click', startRun);
$('adapter').addEventListener('change', updatePolicy);

(async () => {
  await loadHealth();
  await loadAdapters();
  await loadProjects();
  await loadRuns();
  await restoreWorkspace();
  setInterval(() => { loadHealth(); loadRuns(); pollOutput(); }, 2000);
})();
