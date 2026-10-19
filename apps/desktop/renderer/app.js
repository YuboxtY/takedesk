'use strict';
(() => {
  const AIW = window.AIW;
  const h = AIW.h;
  const api = window.aiw;
  const $ = (id) => document.getElementById(id);
  let adapters = [];
  let canvas = null;
  let ready = false;

  AIW.app = {
    projectId: () => $('project').value || null,
    adapter: (id) => adapters.find((a) => a.id === id),
  };

  function saveWorkspace() {
    if (!ready) return;
    api.workspace.save({ projectId: $('project').value || undefined, layout: canvas.serialize() });
  }

  AIW.openTile = (type, state) => {
    if (type === 'review') {
      const existing = canvas.find('review', (t) => t.state.runId === state.runId);
      if (existing) return canvas.focus(existing);
    }
    canvas.add({ type, state });
  };

  async function loadHealth() {
    const r = await api.request('GET', '/v1/health');
    const el = $('status');
    if (r.status === 200 && r.body && r.body.ok) {
      el.textContent = `Core ${r.body.serverVersion} · conectado`;
      el.className = 'chip ok';
    } else {
      el.textContent = 'Core no disponible';
      el.className = 'chip bad';
    }
  }

  async function loadProjects(selectId) {
    const r = await api.request('GET', '/v1/projects');
    const list = r.status === 200 ? r.body.projects : [];
    const sel = $('project');
    sel.replaceChildren(...list.map((p) => h('option', { value: p.id, textContent: `${p.name} — ${p.rootPath}` })));
    if (selectId && list.some((p) => p.id === selectId)) sel.value = selectId;
  }

  async function addProject() {
    const folder = await api.pickFolder();
    if (!folder) return;
    const r = await api.request('POST', '/v1/projects', { path: folder });
    if (r.status === 200 || r.status === 201) {
      $('top-msg').textContent = '';
      await loadProjects(r.body.id);
      saveWorkspace();
    } else {
      $('top-msg').textContent = r.body && r.body.error ? r.body.error.message : `Error ${r.status}`;
    }
  }

  function buildToolbar() {
    const tb = $('toolbar');
    const btn = (label, key, onClick) => h('button', { textContent: label, data: { add: key }, on: { click: onClick } });
    const items = [btn('＋ Terminal', 'terminal', () => AIW.openTile('terminal', {}))];
    for (const a of adapters) items.push(btn(`＋ ${a.displayName}`, `agent:${a.id}`, () => AIW.openTile('agent', { adapter: a.id, mode: 'read' })));
    // Sesiones interactivas reales de cada CLI, cada una en su propio panel/terminal.
    for (const a of adapters.filter((x) => ['claude', 'opencode'].includes(x.id))) {
      items.push(btn(`＋ ${a.displayName} (CLI)`, `cli:${a.id}`, () => AIW.openTile('terminal', { label: `${a.displayName} (CLI)`, autorun: a.id })));
    }
    items.push(btn('＋ Notas', 'notes', () => AIW.openTile('notes', {})));
    tb.replaceChildren(...items);
  }

  api.term.onData((id, data) => { const t = AIW.terms.get(id); if (t) t.write(data); });
  api.term.onExit((id, code) => { const t = AIW.terms.get(id); if (t) t.exit(code); });

  (async () => {
    canvas = AIW.createCanvas($('canvas'), { builders: AIW.builders, onChange: saveWorkspace });
    window.addEventListener('beforeunload', () => canvas.disposeAll());
    $('add-project').addEventListener('click', addProject);
    $('project').addEventListener('change', saveWorkspace);
    await loadHealth();
    const caps = await api.request('GET', '/v1/capabilities');
    adapters = caps.status === 200 ? caps.body.adapters : [];
    buildToolbar();
    const w = await api.workspace.load();
    await loadProjects(w.projectId);
    for (const t of Array.isArray(w.layout) ? w.layout : []) canvas.add(t);
    ready = true;
    setInterval(() => {
      loadHealth();
      for (const inst of canvas.instances()) if (inst.poll) inst.poll();
    }, 2000);
  })();
})();
