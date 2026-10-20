'use strict';
(() => {
  const AIW = window.AIW;
  const h = AIW.h;
  const api = window.aiw;
  const $ = (id) => document.getElementById(id);
  const MAX_SPACES = 12;
  let adapters = [];
  let canvas = null;
  let ready = false;
  let spaces = []; // [{ id, name }]
  let activeSpace = null;
  let armedClose = null; // id del espacio con "cerrar" armado (se confirma con un segundo clic)
  let armTimer = null;
  let theme = 'system';
  const activeSpaceObj = () => spaces.find((s) => s.id === activeSpace);

  AIW.app = {
    projectId: () => $('project').value || null,
    adapter: (id) => adapters.find((a) => a.id === id),
  };

  function saveWorkspace() {
    if (!ready) return;
    api.workspace.save({ projectId: $('project').value || undefined, spaces, activeSpace, theme, layout: canvas.serialize() });
  }

  const newSpaceId = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

  // ------------------------------------------------------------------ paneles
  AIW.openTile = (type, state) => {
    if (type === 'review') {
      const existing = canvas.find('review', (t) => t.state.runId === state.runId && t.space === activeSpace);
      if (existing) return canvas.focus(existing);
    }
    canvas.add({ type, state });
  };

  // ------------------------------------------------------------------ espacios
  function renderSpaces() {
    const bar = $('spaces');
    const tabs = spaces.map((sp, i) => {
      const count = canvas.countIn(sp.id);
      const label = h('span', { className: 'space-name', textContent: sp.name, title: `${sp.name} (Ctrl+Alt+${i + 1}) · doble clic para renombrar` });
      label.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(sp, label); });
      const closeBtn = h('button', {
        className: 'space-close' + (armedClose === sp.id ? ' armed' : ''),
        textContent: armedClose === sp.id ? `¿Cerrar y quitar ${count} panel(es)?` : '×',
        title: 'Cerrar espacio',
        hidden: spaces.length < 2,
        on: { click: (e) => { e.stopPropagation(); closeSpace(sp.id); } },
      });
      return h('div', { className: 'space-tab' + (sp.id === activeSpace ? ' active' : ''), data: { space: sp.id }, on: { click: () => switchSpace(sp.id) } }, label, h('span', { className: 'space-count', textContent: String(count) }), closeBtn);
    });
    const add = h('button', { id: 'space-add', className: 'space-add', textContent: '＋ Espacio', title: 'Nuevo espacio (Ctrl+Shift+S)', disabled: spaces.length >= MAX_SPACES, on: { click: addSpace } });
    bar.replaceChildren(...tabs, add);
  }

  function startRename(sp, label) {
    const input = h('input', { className: 'space-rename', value: sp.name, maxLength: 40 });
    const done = (commit) => {
      if (commit) sp.name = input.value.trim().slice(0, 40) || sp.name;
      renderSpaces();
      saveWorkspace();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  function switchSpace(id) {
    if (!spaces.some((s) => s.id === id) || id === activeSpace) return;
    const cur = spaces.find((s) => s.id === activeSpace);
    if (cur) cur.view = canvas.getView(); // recordar la cámara del espacio que se deja
    activeSpace = id;
    armedClose = null;
    canvas.setActiveSpace(id, spaces.find((s) => s.id === id).view);
    AIW.appearance.apply(activeSpaceObj().bg);
    AIW.appearance.refresh();
    renderSpaces();
    saveWorkspace();
  }

  function addSpace() {
    if (spaces.length >= MAX_SPACES) return;
    const sp = { id: newSpaceId(), name: `Espacio ${spaces.length + 1}` };
    spaces.push(sp);
    switchSpace(sp.id);
  }

  function closeSpace(id) {
    if (spaces.length < 2) return;
    const count = canvas.countIn(id);
    if (count > 0 && armedClose !== id) {
      // Cerrar un espacio con paneles cierra también sus terminales: pide un segundo clic.
      armedClose = id;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armedClose = null; renderSpaces(); }, 4000);
      renderSpaces();
      return;
    }
    armedClose = null;
    canvas.removeSpace(id);
    const idx = spaces.findIndex((s) => s.id === id);
    spaces.splice(idx, 1);
    if (activeSpace === id) {
      activeSpace = spaces[Math.min(idx, spaces.length - 1)].id;
      canvas.setActiveSpace(activeSpace, spaces.find((s) => s.id === activeSpace).view);
      AIW.appearance.apply(activeSpaceObj().bg);
    }
    renderSpaces();
    saveWorkspace();
  }

  function cycleSpace(dir) {
    const i = spaces.findIndex((s) => s.id === activeSpace);
    switchSpace(spaces[(i + dir + spaces.length) % spaces.length].id);
  }

  // ------------------------------------------------------------------ atajos
  // Se evita Ctrl+letra a secas (lo usan los terminales y los editores): todo es Ctrl+Shift o Ctrl+Alt.
  const SHORTCUTS = [
    ['Ctrl+Shift+T', 'Nuevo terminal'],
    ['Ctrl+Shift+A', 'Nuevo panel de agente (el primer modelo disponible)'],
    ['Ctrl+Shift+N', 'Nueva nota'],
    ['Ctrl+Shift+B', 'Nuevo navegador'],
    ['Ctrl+Shift+E', 'Nuevo editor de código'],
    ['Ctrl+Shift+W', 'Cerrar el panel enfocado'],
    ['Ctrl+Shift+S', 'Nuevo espacio'],
    ['Ctrl+Alt+1 … 9', 'Ir al espacio 1 … 9'],
    ['Ctrl+Alt+← / →', 'Espacio anterior / siguiente'],
    ['Ctrl+Alt+↑ / ↓', 'Enfocar el panel anterior / siguiente'],
    ['Ctrl+rueda / pellizco', 'Zoom en el cursor'],
    ['Rueda o arrastrar el fondo', 'Desplazar el lienzo (botón central: desde cualquier sitio)'],
    ['Ctrl+Alt+ + / −', 'Acercar / alejar'],
    ['Ctrl+Alt+0', 'Zoom al 100 %'],
    ['Ctrl+Alt+F', 'Ajustar todos los paneles a la ventana'],
    ['F1', 'Mostrar u ocultar esta ayuda'],
  ];

  function toggleHelp(force) {
    const el = $('help');
    el.hidden = force === undefined ? !el.hidden : !force;
    if (!el.hidden) {
      el.replaceChildren(h('div', { className: 'help-card' }, h('h2', { textContent: 'Atajos de teclado' }), h('table', {}, ...SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', { textContent: k })), h('td', { textContent: d })))), h('p', { className: 'msg', textContent: 'Esc o F1 para cerrar' })));
    }
  }

  function onKey(e) {
    if (e.key === 'Escape' && !$('help').hidden) { toggleHelp(false); return; }
    if (e.key === 'F1') { e.preventDefault(); toggleHelp(); return; }
    const inField = e.target.closest && e.target.closest('input, select');
    if (inField) return;
    let handled = true;
    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      switch (e.code) {
        case 'KeyT': AIW.openTile('terminal', {}); break;
        case 'KeyA': {
          const a = adapters.find((x) => x.id === 'claude') || adapters[0];
          if (a) AIW.openTile('agent', { adapter: a.id, mode: 'read' });
          break;
        }
        case 'KeyN': AIW.openTile('notes', {}); break;
        case 'KeyB': AIW.openTile('browser', {}); break;
        case 'KeyE': AIW.openTile('editor', {}); break;
        case 'KeyW': { const f = canvas.focused(); if (f) canvas.remove(f, 'close'); break; }
        case 'KeyS': addSpace(); break;
        default: handled = false;
      }
    } else if (e.ctrlKey && e.altKey && !e.shiftKey) {
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (digit) { const sp = spaces[Number(digit[1]) - 1]; if (sp) switchSpace(sp.id); }
      else if (e.code === 'Digit0' || e.code === 'Numpad0') canvas.setZoom(1)
      else if (e.code === 'Equal' || e.code === 'NumpadAdd') canvas.zoomBy(1.25)
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') canvas.zoomBy(0.8)
      else if (e.code === 'KeyF') canvas.fitAll()
      else if (e.code === 'ArrowLeft') cycleSpace(-1);
      else if (e.code === 'ArrowRight') cycleSpace(1);
      else if (e.code === 'ArrowUp') canvas.cycleFocus(-1);
      else if (e.code === 'ArrowDown') canvas.cycleFocus(1);
      else handled = false;
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      renderSpaces();
    }
  }

  // ------------------------------------------------------------------ cabecera y proyecto
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
    const btn = (label, key, title, onClick) => h('button', { textContent: label, title, data: { add: key }, on: { click: onClick } });
    const items = [btn('＋ Terminal', 'terminal', 'Ctrl+Shift+T', () => AIW.openTile('terminal', {}))];
    for (const a of adapters) items.push(btn(`＋ ${a.displayName}`, `agent:${a.id}`, 'Panel de agente (Ctrl+Shift+A abre el primero)', () => AIW.openTile('agent', { adapter: a.id, mode: 'read' })));
    // Sesiones interactivas reales de cada CLI, cada una en su propio panel/terminal.
    for (const a of adapters.filter((x) => ['claude', 'opencode'].includes(x.id))) {
      items.push(btn(`＋ ${a.displayName} (CLI)`, `cli:${a.id}`, 'Sesión interactiva en su propio terminal', () => AIW.openTile('terminal', { label: `${a.displayName} (CLI)`, autorun: a.id })));
    }
    items.push(btn('＋ Editor', 'editor', 'Ctrl+Shift+E', () => AIW.openTile('editor', {})));
    items.push(btn('＋ Navegador', 'browser', 'Ctrl+Shift+B', () => AIW.openTile('browser', {})));
    items.push(btn('＋ Notas', 'notes', 'Ctrl+Shift+N', () => AIW.openTile('notes', {})));
    items.push(h('button', { className: 'help-btn', textContent: '⌨ Atajos', title: 'F1', on: { click: () => toggleHelp() } }));
    tb.replaceChildren(...items);
  }

  // las páginas del navegador piden abrir ventanas nuevas: se abren como pestañas del panel que las originó
  api.browser.onOpenTab((sourceId, url) => { for (const b of AIW.browsers) if (b.owns(sourceId)) { b.open(url); break; } });
  api.browser.onBlocked((message) => { $('top-msg').textContent = message; setTimeout(() => { $('top-msg').textContent = ''; }, 5000); });
  api.term.onData((id, data) => { const t = AIW.terms.get(id); if (t) t.write(data); });
  api.term.onExit((id, code) => { const t = AIW.terms.get(id); if (t) t.exit(code); });

  (async () => {
    canvas = AIW.createCanvas($('canvas'), {
      builders: AIW.builders,
      onChange: () => { renderSpaces(); saveWorkspace(); },
      onView: (v) => { const sp = spaces.find((s) => s.id === activeSpace); if (sp) { sp.view = v; saveWorkspace(); } },
    });
    AIW.onZoom = (k) => { const el = $('zoom-label'); if (el) el.textContent = `${Math.round(k * 100)} %`; };
    $('zoom-in').addEventListener('click', () => canvas.zoomBy(1.25));
    $('zoom-out').addEventListener('click', () => canvas.zoomBy(0.8));
    $('zoom-reset').addEventListener('click', () => canvas.setZoom(1));
    $('zoom-fit').addEventListener('click', () => canvas.fitAll());
    window.addEventListener('beforeunload', () => canvas.disposeAll());
    window.addEventListener('keydown', onKey, true);
    $('add-project').addEventListener('click', addProject);
    $('project').addEventListener('change', saveWorkspace);
    await loadHealth();
    const caps = await api.request('GET', '/v1/capabilities');
    adapters = caps.status === 200 ? caps.body.adapters : [];
    buildToolbar();
    const w = await api.workspace.load();
    await loadProjects(w.projectId);
    spaces = Array.isArray(w.spaces) && w.spaces.length ? w.spaces : [{ id: 's1', name: 'Espacio 1' }];
    activeSpace = spaces.some((s) => s.id === w.activeSpace) ? w.activeSpace : spaces[0].id;
    canvas.setActiveSpace(activeSpace, spaces.find((s) => s.id === activeSpace).view);
    for (const t of Array.isArray(w.layout) ? w.layout : []) {
      // Compatibilidad: paneles guardados sin espacio van al primero; un espacio desconocido también.
      canvas.add({ ...t, space: spaces.some((s) => s.id === t.space) ? t.space : spaces[0].id });
    }
    canvas.setActiveSpace(activeSpace, spaces.find((s) => s.id === activeSpace).view);
    theme = w.theme || 'system';
    AIW.appearance.applyTheme(theme);
    AIW.appearance.apply(activeSpaceObj().bg);
    AIW.appearance.mount({
      getBg: () => activeSpaceObj().bg,
      setBg: (bg) => {
        const sp = activeSpaceObj();
        sp.bg = bg;
        saveWorkspace();
      },
      imageInUse: (name) => spaces.some((x) => x.bg && x.bg.image === name),
      getTheme: () => theme,
      setTheme: (t) => { theme = t; saveWorkspace(); },
    });
    ready = true;
    renderSpaces();
    setInterval(() => {
      loadHealth();
      for (const inst of canvas.instances()) if (inst.poll) inst.poll();
    }, 2000);
  })();
})();
