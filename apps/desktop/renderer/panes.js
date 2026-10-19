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
          write: (d) => xt.write(d),
          exit: (code) => xt.write(`\r\n[el terminal terminó con código ${code}]\r\n`),
        });
        await api.term.attach(id); // el Core reenvía el scrollback al reconectar
        refit();
        api.term.resize(id, xt.cols, xt.rows);
        if (created && tile.state.autorun) setTimeout(() => id && api.term.input(id, tile.state.autorun + '\r'), 1800);
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

  AIW.builders = { terminal: terminalPane, agent: agentPane, review: reviewPane, notes: notesPane };
})();
