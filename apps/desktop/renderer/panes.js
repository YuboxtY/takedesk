'use strict';
// Tipos de panel. Cada panel es autónomo: un agente por panel (su propio run y su propia salida),
// un terminal por panel (su propia sesión en el Core), revisión de cambios y notas.
(() => {
  const AIW = window.AIW;
  const h = AIW.h;
  const api = window.aiw;
  const ACTIVE = ['queued', 'starting', 'running', 'waiting_approval', 'cancelling'];
  const errText = (r) => (r.body && r.body.error ? r.body.error.message : `Error ${r.status}`);

  AIW.terms = new Map(); // terminalId -> { write(data), exit(code) }
  AIW.openTile = () => {}; // lo asigna app.js

  // ------------------------------------------------------------------ terminal
  function terminalPane(tile, c) {
    c.setTitle(tile.state.label || 'Terminal');
    const holder = h('div', { className: 'term-holder' });
    const msg = h('div', { className: 'pane-msg', hidden: true });
    c.body.append(holder, msg);
    const xt = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Consolas, "Cascadia Mono", monospace', theme: { background: '#0d1117' } });
    const fit = new window.FitAddon.FitAddon();
    xt.loadAddon(fit);
    xt.open(holder);
    let id = null;
    let destroyed = false;
    let gotData = false;
    let lastData = 0;
    const refit = () => { try { fit.fit(); } catch { /* aún sin tamaño */ } };

    xt.onData((d) => id && api.term.input(id, d));
    xt.onResize(({ cols, rows }) => id && api.term.resize(id, cols, rows));

    (async () => {
      try {
        refit();
        const list = await api.term.list();
        id = tile.state.terminalId && list.some((t) => t.id === tile.state.terminalId && !t.exited) ? tile.state.terminalId : null;
        let created = false;
        if (!id) {
          const projectId = AIW.app.projectId();
          if (!projectId) throw new Error('Añade o selecciona un proyecto primero.');
          const info = await api.term.open(projectId, xt.cols, xt.rows);
          id = info.id;
          created = true;
          c.setState({ terminalId: id });
        }
        if (destroyed) return;
        AIW.terms.set(id, {
          write: (d) => { lastData = Date.now(); gotData = true; xt.write(d); },
          exit: (code) => xt.write(`\r\n[el terminal terminó con código ${code}]\r\n`),
        });
        await api.term.attach(id); // el Core reenvía el scrollback al reconectar
        refit();
        api.term.resize(id, xt.cols, xt.rows);
        if (created && tile.state.autorun) {
          // Esperar a que el shell esté listo (salida inicial y 500 ms sin datos); si no, a los 10 s.
          const t0 = Date.now();
          while (!destroyed && Date.now() - t0 < 10000 && !(gotData && Date.now() - lastData > 500)) await new Promise((r) => setTimeout(r, 150));
          if (!destroyed && id) api.term.input(id, tile.state.autorun + '\r');
        }
      } catch (e) {
        msg.hidden = false;
        msg.textContent = String(e.message || e);
      }
    })();

    return {
      onResize: refit,
      destroy(reason) {
        destroyed = true;
        if (id) {
          AIW.terms.delete(id);
          if (reason === 'close') api.term.kill(id).catch(() => {}); // cerrar el panel cierra su terminal
        }
        xt.dispose();
      },
    };
  }

  // ------------------------------------------------------------------ agente (un modelo por panel)
  function agentPane(tile, c) {
    const meta = AIW.app.adapter(tile.state.adapter) || { id: tile.state.adapter, displayName: tile.state.adapter, dataPolicy: 'private-ok' };
    c.setTitle(`${meta.displayName} · agente`);
    const out = h('pre', { className: 'agent-out', textContent: '' });
    const prompt = h('textarea', { className: 'agent-prompt', rows: 2, placeholder: `Instrucción para ${meta.displayName}…` });
    const mode = h('select', { className: 'agent-mode' }, h('option', { value: 'read', textContent: 'Lectura (plan)' }), h('option', { value: 'write', textContent: 'Escritura (worktree)' }));
    mode.value = tile.state.mode || 'read';
    mode.addEventListener('change', () => c.setState({ mode: mode.value }));
    const policy = h('input', { type: 'checkbox', className: 'agent-policy' });
    const policyRow = h('label', { className: 'policy', hidden: meta.dataPolicy !== 'may-train' }, policy, ' Acepto que este proveedor puede usar los datos para entrenar modelos');
    const status = h('span', { className: 'agent-status chip', textContent: 'inactivo' });
    const msg = h('span', { className: 'msg' });
    const send = h('button', { className: 'agent-send primary', textContent: 'Enviar' });
    const cancel = h('button', { className: 'agent-cancel', textContent: 'Cancelar', hidden: true });
    const review = h('button', { className: 'agent-review', textContent: 'Revisar cambios', hidden: true });
    c.actions.append(status);
    c.body.append(out, h('div', { className: 'agent-bar' }, prompt, policyRow, h('div', { className: 'row' }, mode, send, cancel, review, msg)));

    let runId = tile.state.runId || null;
    let since = 0;
    let busy = false;
    let lastState = null;

    const textOf = (e) => {
      switch (e.kind) {
        case 'output.delta': return e.text;
        case 'tool.started': return `\n▶ ${e.name}\n`;
        case 'tool.finished': return `${e.ok ? '✔' : '✘'} ${e.summary ? e.summary.split('\n')[0] : ''}\n`;
        case 'error': return `\n[error] ${e.message}\n`;
        case 'run.finished': return `\n— terminó: ${e.ok ? 'ok' : 'con fallo'}${e.reason ? ' (' + e.reason + ')' : ''}\n`;
        default: return '';
      }
    };

    async function poll() {
      if (!runId || busy) return;
      busy = true;
      try {
        const id = runId;
        const r = await api.request('GET', `/v1/runs/${id}`);
        if (id !== runId || r.status !== 200) return;
        const run = r.body;
        lastState = run.state;
        status.textContent = run.state;
        status.dataset.state = run.state;
        const active = ACTIVE.includes(run.state);
        send.disabled = active;
        cancel.hidden = !active;
        review.hidden = !(run.mode === 'write' && run.state === 'completed' && run.worktreeStatus === 'active');
        const ev = await api.request('GET', `/v1/runs/${id}/events?since=${since}&limit=500`);
        if (id !== runId) return;
        if (ev.status === 200) {
          for (const rec of ev.body.events) {
            since = Math.max(since, rec.seq);
            out.textContent += textOf(rec.event);
          }
          out.scrollTop = out.scrollHeight;
        } else if (ev.status === 410) out.textContent = errText(ev);
      } finally {
        busy = false;
      }
    }

    send.addEventListener('click', async () => {
      const text = prompt.value.trim();
      const projectId = AIW.app.projectId();
      if (!projectId) return (msg.textContent = 'Añade o selecciona un proyecto primero.');
      if (!text) return (msg.textContent = 'Escribe una instrucción.');
      msg.textContent = '';
      const r = await api.request('POST', '/v1/runs', { projectId, adapter: meta.id, prompt: text, mode: mode.value, title: text.slice(0, 60), acceptDataPolicy: policy.checked || undefined });
      if (r.status !== 201) return (msg.textContent = errText(r));
      runId = r.body.id;
      since = 0;
      c.setState({ runId });
      out.textContent += `${out.textContent ? '\n\n' : ''}» ${text}\n`;
      prompt.value = '';
      send.disabled = true;
      poll();
    });
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send.click();
    });
    cancel.addEventListener('click', async () => {
      if (runId) await api.request('POST', `/v1/runs/${runId}/cancel`);
      poll();
    });
    review.addEventListener('click', () => runId && AIW.openTile('review', { runId, label: meta.displayName }));
    if (runId) poll();
    return { poll, runId: () => runId, state: () => lastState };
  }

  // ------------------------------------------------------------------ revisión de cambios (CA-04)
  function renderPatch(patch) {
    const frag = document.createDocumentFragment();
    for (const line of patch.split('\n')) {
      const cls = line.startsWith('+++') || line.startsWith('---') ? '' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      frag.appendChild(h('span', { className: cls, textContent: line + '\n' }));
    }
    return frag;
  }

  function reviewPane(tile, c) {
    c.setTitle(`Revisión · ${tile.state.label || tile.state.runId}`);
    const summary = h('p', { className: 'review-summary msg' });
    const warn = h('p', { className: 'review-warn msg bad', hidden: true });
    const patch = h('pre', { className: 'review-patch' });
    const msg = h('span', { className: 'review-msg msg' });
    const merge = h('button', { className: 'review-merge primary', textContent: 'Aprobar y fusionar', disabled: true });
    const reload = h('button', { textContent: 'Recargar', on: { click: () => load() } });
    c.body.append(summary, warn, patch, h('div', { className: 'row' }, merge, reload, msg));
    let reviewedHead = null;
    const runId = tile.state.runId;

    async function load() {
      msg.textContent = 'Cargando diff…';
      merge.disabled = true;
      reviewedHead = null;
      patch.replaceChildren();
      const r = await api.request('GET', `/v1/runs/${runId}/diff`);
      if (r.status !== 200) {
        msg.textContent = errText(r);
        msg.classList.add('bad');
        return;
      }
      const d = r.body;
      reviewedHead = d.reviewedHead;
      msg.textContent = '';
      msg.classList.remove('bad');
      summary.textContent = d.files.length ? `${d.files.length} archivo(s): ` + d.files.map((f) => `${f.status} ${f.path}`).join(', ') : 'El agente no hizo cambios.';
      warn.hidden = !d.targetDirty && !d.truncated;
      warn.textContent = d.targetDirty
        ? 'El proyecto tiene cambios locales sin guardar: guárdalos o descártalos antes de fusionar.'
        : d.truncated ? 'El diff es muy grande y se muestra truncado; revísalo completo antes de aprobar.' : '';
      patch.replaceChildren(renderPatch(d.patch || ''));
      merge.disabled = d.files.length === 0;
    }

    merge.addEventListener('click', async () => {
      if (!reviewedHead) return;
      merge.disabled = true;
      msg.textContent = 'Fusionando…';
      msg.classList.remove('bad');
      const r = await api.request('POST', `/v1/runs/${runId}/merge`, { approvedHead: reviewedHead });
      if (r.status === 200) {
        msg.textContent = 'Fusionado en la rama principal.';
        reviewedHead = null;
      } else {
        msg.textContent = errText(r);
        msg.classList.add('bad');
        merge.disabled = false;
      }
    });
    load();
    return {};
  }

  // ------------------------------------------------------------------ notas
  function notesPane(tile, c) {
    c.setTitle('Notas');
    const area = h('textarea', { className: 'notes-area', placeholder: 'Notas del proyecto…', value: tile.state.text || '' });
    area.addEventListener('input', () => c.setState({ text: area.value.slice(0, 20000) }));
    c.body.append(area);
    return {};
  }

  // ------------------------------------------------------------------ navegador con pestañas
  // Cada pestaña es un <webview> aislado (perfil propio, sin Node, solo http/https; ver main.cjs).
  AIW.browsers = new Set(); // paneles que atienden las "ventanas nuevas" de sus páginas

  function browserPane(tile, c) {
    c.setTitle('Navegador');
    let tabs = []; // { view, url, title, loading }
    let active = 0;
    let seq = 0;
    const strip = h('div', { className: 'br-tabs' });
    const back = h('button', { className: 'br-back', textContent: '‹', title: 'Atrás', on: { click: () => tabs[active] && safe(() => tabs[active].view.goBack()) } });
    const fwd = h('button', { className: 'br-fwd', textContent: '›', title: 'Adelante', on: { click: () => tabs[active] && safe(() => tabs[active].view.goForward()) } });
    const reload = h('button', { className: 'br-reload', textContent: '⟳', title: 'Recargar', on: { click: () => tabs[active] && safe(() => (tabs[active].loading ? tabs[active].view.stop() : tabs[active].view.reload())) } });
    const url = h('input', { className: 'br-url', type: 'text', placeholder: 'Dirección o búsqueda (p. ej. localhost:3000)', spellcheck: false });
    const ext = h('button', { className: 'br-ext', textContent: '↗', title: 'Abrir en el navegador del sistema', on: { click: () => { const u = tabs[active] && tabs[active].url; if (u) api.browser.openExternal(u); } } });
    const msg = h('div', { className: 'br-msg msg', hidden: true });
    const stage = h('div', { className: 'br-stage' });
    const empty = h('div', { className: 'br-empty', textContent: 'Escribe una dirección arriba, por ejemplo localhost:3000 o example.com' });
    stage.append(empty);
    c.body.append(strip, h('div', { className: 'br-bar' }, back, fwd, reload, url, ext), msg, stage);

    function safe(fn) { try { return fn(); } catch { return undefined; } }
    function flash(text) {
      msg.textContent = text;
      msg.hidden = !text;
    }
    function persist() {
      c.setState({ tabs: JSON.stringify(tabs.map((t) => t.url).filter((u) => /^https?:\/\//.test(u))), active });
    }
    function sync() {
      const t = tabs[active];
      empty.hidden = tabs.length > 0 && Boolean(t && t.url && t.url !== 'about:blank');
      for (const x of tabs) x.view.style.display = x === t ? '' : 'none';
      if (t && document.activeElement !== url) url.value = t.url === 'about:blank' ? '' : t.url;
      back.disabled = !t || !safe(() => t.view.canGoBack());
      fwd.disabled = !t || !safe(() => t.view.canGoForward());
      reload.textContent = t && t.loading ? '✕' : '⟳';
      reload.title = t && t.loading ? 'Detener' : 'Recargar';
      c.setTitle(t && t.title ? `Navegador · ${t.title}` : 'Navegador');
      renderTabs();
    }
    function renderTabs() {
      strip.replaceChildren(
        ...tabs.map((t, i) => h('div', { className: 'br-tab' + (i === active ? ' active' : ''), data: { tab: String(i) }, title: t.url, on: { click: () => select(i) } },
          h('span', { className: 'br-tab-title', textContent: t.title || (t.url && t.url !== 'about:blank' ? t.url : 'Pestaña nueva') }),
          h('button', { className: 'br-tab-close', textContent: '×', title: 'Cerrar pestaña', on: { click: (e) => { e.stopPropagation(); closeTab(i); } } }))),
        h('button', { className: 'br-newtab', textContent: '＋', title: 'Pestaña nueva', on: { click: () => { addTab('about:blank'); url.focus(); } } }),
      );
    }
    function select(i) {
      active = Math.min(Math.max(i, 0), tabs.length - 1);
      sync();
      persist();
    }
    function addTab(target) {
      const view = h('webview', { className: 'br-view', attrs: { partition: 'persist:aiw-browser', allowpopups: '', src: target || 'about:blank' } });
      const t = { id: ++seq, view, url: target || 'about:blank', title: '', loading: false };
      view.addEventListener('page-title-updated', (e) => { t.title = e.title; if (tabs[active] === t) sync(); else renderTabs(); });
      const nav = (e) => { if (e.isMainFrame !== false) { t.url = e.url; persist(); if (tabs[active] === t) sync(); else renderTabs(); } };
      view.addEventListener('did-navigate', nav);
      view.addEventListener('did-navigate-in-page', nav);
      view.addEventListener('did-start-loading', () => { t.loading = true; if (tabs[active] === t) sync(); });
      view.addEventListener('did-stop-loading', () => { t.loading = false; if (tabs[active] === t) sync(); });
      view.addEventListener('did-fail-load', (e) => { if (e.isMainFrame && e.errorCode !== -3) flash(`No se pudo cargar (${e.errorDescription || e.errorCode})`); });
      stage.append(view);
      tabs.push(t);
      active = tabs.length - 1;
      sync();
      persist();
      return t;
    }
    function closeTab(i) {
      const t = tabs[i];
      if (!t) return;
      tabs.splice(i, 1);
      t.view.remove();
      if (!tabs.length) addTab('about:blank');
      else select(Math.min(active > i ? active - 1 : active, tabs.length - 1));
      persist();
    }
    function go(text) {
      const r = AIW.url.normalizeUrl(text);
      if (r.error) return flash(r.error);
      flash('');
      const t = tabs[active] || addTab('about:blank');
      t.url = r.url;
      if (t.view.getURL && safe(() => t.view.getURL()) !== undefined && safe(() => t.view.getWebContentsId()) !== undefined) safe(() => t.view.loadURL(r.url));
      else t.view.setAttribute('src', r.url);
      sync();
      persist();
    }
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(url.value); url.blur(); }
      else if (e.key === 'Escape') { url.value = tabs[active] && tabs[active].url !== 'about:blank' ? tabs[active].url : ''; url.blur(); }
    });
    url.addEventListener('focus', () => url.select());

    const handler = {
      owns: (webContentsId) => tabs.some((t) => safe(() => t.view.getWebContentsId()) === webContentsId),
      open: (u) => addTab(u),
    };
    AIW.browsers.add(handler);

    let saved = [];
    try { saved = JSON.parse(tile.state.tabs || '[]'); } catch { saved = []; }
    saved = saved.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 12);
    const savedActive = Number(tile.state.active) || 0; // leerlo antes: addTab() lo sobrescribe al persistir
    if (saved.length) { for (const u of saved) addTab(u); select(Math.min(savedActive, tabs.length - 1)); }
    else addTab('about:blank');
    renderTabs();

    return {
      destroy() {
        AIW.browsers.delete(handler);
        for (const t of tabs) t.view.remove();
      },
      onResize() {},
      /** Para pruebas y atajos: navegar la pestaña activa. */
      go,
    };
  }

  // ------------------------------------------------------------------ editor (Monaco) + explorador de archivos
  let monacoPromise = null;
  /** Monaco se carga la primera vez que se abre un editor (así el arranque es ligero y xterm no choca con su cargador AMD). */
  function loadMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      const base = '../node_modules/monaco-editor/min/vs';
      const s = h('script', { src: `${base}/loader.js` });
      s.onerror = () => reject(new Error('No se pudo cargar el editor'));
      s.onload = () => {
        window.require.config({ paths: { vs: base }, 'vs/nls': { availableLanguages: { '*': 'es' } } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (e) => reject(new Error(String(e && e.message ? e.message : e))));
      };
      document.head.append(s);
    });
    return monacoPromise;
  }
  const monacoTheme = () => (AIW.themeIsLight && AIW.themeIsLight() ? 'vs' : 'vs-dark');
  AIW.onTheme = () => { if (window.monaco) window.monaco.editor.setTheme(monacoTheme()); };

  function editorPane(tile, c) {
    c.setTitle('Editor');
    const projectId = tile.state.projectId || AIW.app.projectId();
    if (projectId && !tile.state.projectId) c.setState({ projectId });
    const tree = h('div', { className: 'ed-tree' });
    const tabsEl = h('div', { className: 'ed-tabs' });
    const host = h('div', { className: 'ed-host' });
    const status = h('div', { className: 'ed-status msg' });
    const treeToggle = h('button', { className: 'ed-toggle', textContent: '☰', title: 'Mostrar u ocultar el explorador', on: { click: () => { tree.hidden = !tree.hidden; } } });
    const save = h('button', { className: 'ed-save', textContent: 'Guardar', title: 'Guardar (Ctrl+S)', on: { click: () => saveActive(false) } });
    c.actions.append(treeToggle, save);
    c.body.classList.add('ed-body');
    c.body.append(tree, h('div', { className: 'ed-main' }, tabsEl, host, status));

    let monaco = null;
    let editor = null;
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; }); // las aperturas de archivo esperan a que Monaco esté cargado
    let activeRel = null;
    let destroyed = false;
    let armedClose = null;
    const docs = new Map(); // rel -> { model, mtimeMs, saved }

    const say = (text, bad) => { status.replaceChildren(text || ''); status.classList.toggle('bad', Boolean(bad)); };
    const isDirty = (d) => d.model.getValue() !== d.saved;
    const persist = () => c.setState({ files: JSON.stringify([...docs.keys()]), active: activeRel || '' });

    function renderTabs() {
      tabsEl.replaceChildren(...[...docs.entries()].map(([rel, d]) => {
        const name = rel.split('/').pop();
        return h('div', { className: 'ed-tab' + (rel === activeRel ? ' active' : ''), title: rel, data: { file: rel }, on: { click: () => activate(rel) } },
          h('span', { className: 'ed-tab-name', textContent: name + (isDirty(d) ? ' ●' : '') }),
          h('button', { className: 'ed-tab-close', textContent: armedClose === rel ? '¿Descartar?' : '×', title: 'Cerrar', on: { click: (e) => { e.stopPropagation(); closeFile(rel); } } }));
      }));
    }

    function activate(rel) {
      const d = docs.get(rel);
      if (!d || !editor) return;
      activeRel = rel;
      editor.setModel(d.model);
      c.setTitle(`Editor · ${rel.split('/').pop()}`);
      renderTabs();
      persist();
      editor.focus();
    }

    async function openFile(rel) {
      if (!monaco) say('Cargando el editor…');
      await ready;
      if (destroyed) return;
      if (docs.has(rel)) return activate(rel);
      const r = await api.files.read(projectId, rel);
      if (destroyed) return;
      if (!r.ok) return say(`${rel}: ${r.error}`, true);
      const ext = '.' + (rel.split('.').pop() || '').toLowerCase();
      const lang = monaco.languages.getLanguages().find((l) => (l.extensions || []).includes(ext));
      const model = monaco.editor.createModel(r.content, lang ? lang.id : 'plaintext');
      const d = { model, mtimeMs: r.mtimeMs, saved: model.getValue() };
      model.onDidChangeContent(() => renderTabs());
      docs.set(rel, d);
      say('');
      activate(rel);
    }

    async function saveActive(force) {
      const d = activeRel && docs.get(activeRel);
      if (!d) return;
      const value = d.model.getValue();
      const r = await api.files.write(projectId, activeRel, value, { expectedMtimeMs: d.mtimeMs, force });
      if (r.ok) {
        d.mtimeMs = r.mtimeMs;
        d.saved = value;
        say(`Guardado ${activeRel}`);
        renderTabs();
      } else if (r.code === 'conflict') {
        status.textContent = '';
        status.classList.add('bad');
        status.append('El archivo cambió en disco. ',
          h('button', { className: 'ed-overwrite', textContent: 'Sobrescribir', on: { click: () => saveActive(true) } }), ' ',
          h('button', { className: 'ed-reload', textContent: 'Recargar del disco', on: { click: () => reloadActive() } }));
      } else say(r.error, true);
    }

    async function reloadActive() {
      const rel = activeRel;
      const d = rel && docs.get(rel);
      if (!d) return;
      const r = await api.files.read(projectId, rel);
      if (!r.ok) return say(r.error, true);
      d.model.setValue(r.content);
      d.mtimeMs = r.mtimeMs;
      d.saved = d.model.getValue();
      say(`Recargado ${rel}`);
      renderTabs();
    }

    function closeFile(rel) {
      const d = docs.get(rel);
      if (!d) return;
      if (isDirty(d) && armedClose !== rel) { // con cambios sin guardar: pide un segundo clic
        armedClose = rel;
        renderTabs();
        setTimeout(() => { if (armedClose === rel) { armedClose = null; renderTabs(); } }, 4000);
        return;
      }
      armedClose = null;
      docs.delete(rel);
      d.model.dispose();
      if (activeRel === rel) {
        const next = [...docs.keys()].pop();
        activeRel = null;
        if (next) activate(next); else { editor.setModel(null); c.setTitle('Editor'); renderTabs(); persist(); }
      } else { renderTabs(); persist(); }
    }

    // ---- explorador
    const expanded = new Set();
    async function fill(container, rel, depth) {
      const r = await api.files.list(projectId, rel);
      if (destroyed) return;
      container.replaceChildren();
      if (!r.ok) return container.append(h('div', { className: 'ed-err', textContent: r.error }));
      for (const e of r.entries) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        const row = h('div', { className: 'ed-node ' + e.type, data: { path, type: e.type }, attrs: { style: `padding-left:${8 + depth * 12}px` } });
        if (e.type === 'dir') {
          const kids = h('div', { className: 'ed-kids', hidden: !expanded.has(path) });
          const arrow = h('span', { className: 'ed-arrow', textContent: expanded.has(path) ? '▾' : '▸' });
          row.append(arrow, ' ' + e.name);
          row.addEventListener('click', async () => {
            if (expanded.has(path)) { expanded.delete(path); kids.hidden = true; arrow.textContent = '▸'; return; }
            expanded.add(path); kids.hidden = false; arrow.textContent = '▾';
            await fill(kids, path, depth + 1);
          });
          container.append(row, kids);
          if (expanded.has(path)) fill(kids, path, depth + 1);
        } else {
          row.append('  ' + e.name);
          row.addEventListener('click', () => openFile(path));
          container.append(row);
        }
      }
      if (r.truncated) container.append(h('div', { className: 'ed-err', textContent: '… hay más entradas de las que se muestran' }));
    }
    const refreshTree = () => fill(tree, '', 0);

    if (!projectId) { say('Añade o selecciona un proyecto para abrir sus archivos.', true); return {}; }
    refreshTree();
    loadMonaco().then(async (m) => {
      if (destroyed) return;
      monaco = m;
      m.editor.setTheme(monacoTheme());
      editor = m.editor.create(host, { automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, model: null, fontFamily: 'Consolas, "Cascadia Mono", monospace' });
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => saveActive(false));
      resolveReady();
      let saved = [];
      try { saved = JSON.parse(tile.state.files || '[]'); } catch { saved = []; }
      const wanted = tile.state.active;
      for (const rel of saved.filter((x) => typeof x === 'string').slice(0, 20)) await openFile(rel);
      if (wanted && docs.has(wanted)) activate(wanted);
      if (!docs.size) say('Elige un archivo en el explorador.');
    }).catch((e) => say(String(e.message || e), true));

    return {
      refresh: refreshTree,
      destroy() {
        destroyed = true;
        for (const d of docs.values()) d.model.dispose();
        if (editor) editor.dispose();
      },
    };
  }

  // ------------------------------------------------------------------ apps del equipo
  function appsPane(tile, c) {
    c.setTitle('Apps');
    const projectId = tile.state.projectId || AIW.app.projectId();
    if (projectId && !tile.state.projectId) c.setState({ projectId });
    const list = h('div', { className: 'apps-list' });
    const msg = h('p', { className: 'apps-msg msg' });
    c.body.append(
      h('p', { className: 'msg', textContent: 'Abre estas apps en la carpeta del proyecto. Windows no permite incrustar sus ventanas dentro del lienzo: se abren aparte; el terminal, el editor y el navegador integrados sí viven aquí.' }),
      list, msg,
    );
    (async () => {
      if (!projectId) { msg.textContent = 'Añade o selecciona un proyecto primero.'; return; }
      const r = await api.apps.list(projectId);
      if (!r.ok) { msg.textContent = r.error; return; }
      list.replaceChildren(...r.apps.map((a) => h('button', {
        className: 'app-btn', textContent: a.label, disabled: !a.available, data: { app: a.id },
        title: a.available ? 'Abrir en la carpeta del proyecto' : 'No está instalada',
        on: { click: async () => {
          const x = await api.apps.launch(a.id, projectId);
          msg.textContent = x.ok ? `Abierto: ${a.label}` : x.error;
          msg.classList.toggle('bad', !x.ok);
        } },
      })));
    })();
    return {};
  }

  AIW.builders = { terminal: terminalPane, agent: agentPane, review: reviewPane, notes: notesPane, browser: browserPane, editor: editorPane, apps: appsPane };
})();
