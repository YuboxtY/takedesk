'use strict';
// Lienzo infinito de paneles ("tiles"): cada panel es independiente (un agente, un terminal, una revisión,
// un navegador…), se arrastra por su cabecera, se redimensiona por la esquina y recuerda su sitio. El lienzo
// se desplaza (paneo) y se amplía/reduce (zoom) con una cámara por espacio. Sin innerHTML: todo se construye
// con h() y textContent (los datos de agentes y archivos no son confiables).
(() => {
  const AIW = (window.AIW = window.AIW || {});
  const GRID = 10;
  const MIN_W = 280;
  const MIN_H = 160;
  const MIN_K = 0.1;
  const MAX_K = 3;
  // Zonas ocupadas por las barras flotantes (arriba, rail de espacios, dock, HUD): la cámara y los paneles nuevos las respetan.
  const INSET = { top: 84, left: 96, right: 24, bottom: 96 };
  const HOME = { x: INSET.left + 20, y: INSET.top + 20, k: 1 };
  const snap = (v) => Math.round(v / GRID) * GRID;
  const clampK = (k) => Math.min(MAX_K, Math.max(MIN_K, k));

  AIW.h = function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else if (k === 'attrs') for (const [ak, av] of Object.entries(v)) el.setAttribute(ak, av);
      else el[k] = v;
    }
    for (const kid of kids.flat()) if (kid !== undefined && kid !== null) el.append(kid);
    return el;
  };
  const h = AIW.h;

  const DEFAULT_SIZE = {
    terminal: [540, 330],
    agent: [500, 400],
    review: [580, 420],
    notes: [300, 230],
    browser: [640, 440],
    editor: [700, 460],
    apps: [320, 300],
  };

  /**
   * root: el "mundo" (se le aplica la transformación de la cámara); su padre es el viewport.
   * builders: { tipo: (tile, ctx) => { destroy?(reason), onResize?() } }.
   * onChange: cambios de paneles (posición, tamaño, estado, conjunto), sin rebote.
   * onView: cambios de la cámara, sin rebote.
   */
  AIW.createCanvas = function createCanvas(root, { builders, onChange, onView }) {
    const viewport = root.parentElement;
    const entries = new Map(); // id -> { tile, frame, body, titleEl, actionsEl, inst }
    let zTop = 1;
    let seq = 0;
    let activeSpace = null;
    let focusedId = null;
    let view = { ...HOME };
    let timer = null;
    let viewTimer = null;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onChange && onChange(), 400);
    };

    // ------------------------------------------------------------------ cámara
    function applyView() {
      root.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
      viewport.style.setProperty('--vx', `${view.x}px`);
      viewport.style.setProperty('--vy', `${view.y}px`);
      viewport.style.setProperty('--vk', String(view.k));
      viewport.dataset.zoom = String(Math.round(view.k * 100));
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => onView && onView({ ...view }), 300);
      if (AIW.onZoom) AIW.onZoom(view.k);
    }

    const vsize = () => ({ w: viewport.clientWidth, h: viewport.clientHeight });

    function zoomAt(factor, cx, cy) {
      const r = viewport.getBoundingClientRect();
      const px = (cx ?? r.left + r.width / 2) - r.left;
      const py = (cy ?? r.top + r.height / 2) - r.top;
      const k = clampK(view.k * factor);
      const wx = (px - view.x) / view.k;
      const wy = (py - view.y) / view.k;
      view = { k, x: px - wx * k, y: py - wy * k };
      applyView();
    }

    function setZoom(k) {
      zoomAt(clampK(k) / view.k);
    }

    function fitAll() {
      const list = [...entries.values()].map((e) => e.tile).filter((t) => t.space === activeSpace);
      const { w, h: vh } = vsize();
      if (!list.length || !w) {
        view = { ...HOME };
        return applyView();
      }
      const minX = Math.min(...list.map((t) => t.x));
      const minY = Math.min(...list.map((t) => t.y));
      const maxX = Math.max(...list.map((t) => t.x + t.w));
      const maxY = Math.max(...list.map((t) => t.y + t.h));
      const aw = w - INSET.left - INSET.right;
      const ah = vh - INSET.top - INSET.bottom;
      const k = clampK(Math.min(aw / (maxX - minX), ah / (maxY - minY), 1));
      view = { k, x: INSET.left + (aw - (maxX - minX) * k) / 2 - minX * k, y: INSET.top + (ah - (maxY - minY) * k) / 2 - minY * k };
      applyView();
    }

    /** Desplaza la cámara lo mínimo para que el panel quede a la vista. */
    function ensureVisible(tile) {
      const { w, h: vh } = vsize();
      const m = 16;
      const L = INSET.left + m, T = INSET.top + m, R = w - INSET.right - m, B = vh - INSET.bottom - m;
      const left = tile.x * view.k + view.x, top = tile.y * view.k + view.y;
      const right = left + tile.w * view.k, bottom = top + tile.h * view.k;
      let { x, y } = view;
      if (left < L) x += L - left; else if (right > R) x -= right - R;
      if (top < T) y += T - top; else if (bottom > B) y -= bottom - B;
      if (tile.w * view.k > R - L) x = L - tile.x * view.k; // más ancho que la zona libre: alinear a la izquierda
      if (tile.h * view.k > B - T) y = T - tile.y * view.k;
      if (x !== view.x || y !== view.y) { view = { ...view, x, y }; applyView(); }
    }

    // rueda: Ctrl+rueda (y el pellizco del trackpad) hace zoom en el cursor; sobre el fondo, la rueda desplaza.
    viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
      } else if (!e.target.closest('.tile')) {
        e.preventDefault();
        view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
        applyView();
      }
    }, { passive: false });

    // arrastrar el fondo (o el botón central en cualquier sitio) desplaza el lienzo
    viewport.addEventListener('pointerdown', (e) => {
      const onBg = e.target === viewport || e.target === root;
      if (!((e.button === 0 && onBg) || e.button === 1)) return;
      e.preventDefault();
      viewport.classList.add('panning');
      const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
      const move = (ev) => { view = { ...view, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }; applyView(); };
      const up = () => {
        viewport.classList.remove('panning');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // ------------------------------------------------------------------ paneles
    function place(frame, t) {
      frame.style.left = t.x + 'px';
      frame.style.top = t.y + 'px';
      frame.style.width = t.w + 'px';
      frame.style.height = t.h + 'px';
      frame.style.zIndex = String(t.z);
    }

    function focus(id) {
      const e = entries.get(id);
      if (!e) return;
      focusedId = id;
      for (const o of entries.values()) o.frame.classList.toggle('focused', o === e);
      if (e.tile.z !== zTop) {
        e.tile.z = ++zTop;
        e.frame.style.zIndex = String(e.tile.z);
        changed();
      }
    }

    function startDrag(e, ent) {
      if (e.button !== 0 || e.target.closest('button, select, input, textarea')) return;
      focus(ent.tile.id);
      const sx = e.clientX, sy = e.clientY, ox = ent.tile.x, oy = ent.tile.y;
      const move = (ev) => {
        ent.tile.x = snap(ox + (ev.clientX - sx) / view.k);
        ent.tile.y = snap(oy + (ev.clientY - sy) / view.k);
        place(ent.frame, ent.tile);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        changed();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    }

    function startResize(e, ent) {
      if (e.button !== 0) return;
      focus(ent.tile.id);
      const sx = e.clientX, sy = e.clientY, ow = ent.tile.w, oh = ent.tile.h;
      const move = (ev) => {
        ent.tile.w = Math.max(MIN_W, snap(ow + (ev.clientX - sx) / view.k));
        ent.tile.h = Math.max(MIN_H, snap(oh + (ev.clientY - sy) / view.k));
        place(ent.frame, ent.tile);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        changed();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
      e.stopPropagation();
    }

    /** Primer hueco sin solapar dentro del área visible (en coordenadas del mundo); si no hay, en cascada. */
    function freeSpot(w, h, space) {
      const { w: vw, h: vh } = vsize();
      const x0 = Math.ceil(((INSET.left + 20 - view.x) / view.k) / 20) * 20;
      const y0 = Math.ceil(((INSET.top + 20 - view.y) / view.k) / 20) * 20;
      const maxX = Math.max(x0 + w + 20, ((vw || 1200) - INSET.right - view.x) / view.k);
      const maxY = y0 + Math.max(h + 40, 8000);
      const rects = [...entries.values()].map(({ tile }) => tile).filter((t) => t.space === space);
      const free = (x, y) => rects.every((r) => x + w + 10 <= r.x || r.x + r.w + 10 <= x || y + h + 10 <= r.y || r.y + r.h + 10 <= y);
      for (let y = y0; y + h <= maxY; y += 20) for (let x = x0; x + w <= maxX; x += 20) if (free(x, y)) return { x, y };
      const n = rects.length;
      return { x: x0 + (n % 8) * 30, y: y0 + (n % 8) * 30 };
    }

    function add(input) {
      const build = builders[input.type];
      if (!build) return null;
      const [dw, dh] = DEFAULT_SIZE[input.type] || [480, 320];
      const tile = {
        id: input.id || `t${Date.now().toString(36)}${(seq++).toString(36)}`,
        type: input.type,
        x: input.x,
        y: input.y,
        w: Math.max(MIN_W, input.w || dw),
        h: Math.max(MIN_H, input.h || dh),
        z: input.z || ++zTop,
        state: { ...(input.state || {}) },
        space: input.space || activeSpace,
      };
      if (!Number.isFinite(tile.x) || !Number.isFinite(tile.y)) {
        const spot = freeSpot(tile.w, tile.h, tile.space);
        tile.x = spot.x;
        tile.y = spot.y;
      }
      zTop = Math.max(zTop, tile.z);
      const titleEl = h('span', { className: 'tile-title', textContent: tile.type });
      const actionsEl = h('span', { className: 'tile-actions' });
      const ent = { tile, titleEl, actionsEl, inst: null };
      const closeBtn = h('button', { className: 'tile-close', textContent: '×', title: 'Cerrar panel', on: { click: () => remove(tile.id, 'close') } });
      const head = h('div', { className: 'tile-head', on: { pointerdown: (e) => startDrag(e, ent) } }, titleEl, actionsEl, closeBtn);
      const body = h('div', { className: 'tile-body' });
      const grip = h('div', { className: 'tile-grip', on: { pointerdown: (e) => startResize(e, ent) } });
      const frame = h('section', { className: 'tile', data: { tileId: tile.id, type: tile.type }, on: { pointerdown: () => focus(tile.id) } }, head, body, grip);
      ent.frame = frame;
      ent.body = body;
      place(frame, tile);
      frame.classList.toggle('other-space', tile.space !== activeSpace);
      root.append(frame);
      entries.set(tile.id, ent);
      const ctx = {
        body,
        actions: actionsEl,
        setTitle: (t) => { titleEl.textContent = t; },
        setState: (patch) => { Object.assign(tile.state, patch); changed(); },
        close: () => remove(tile.id, 'close'),
      };
      ent.inst = build(tile, ctx) || {};
      let raf = 0;
      ent.ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => ent.inst.onResize && ent.inst.onResize());
      });
      ent.ro.observe(body);
      if (tile.space === activeSpace) focus(tile.id);
      changed();
      return tile.id;
    }

    function remove(id, reason = 'close') {
      const ent = entries.get(id);
      if (!ent) return;
      entries.delete(id);
      if (focusedId === id) focusedId = null;
      try { ent.ro.disconnect(); } catch { /* ya liberado */ }
      try { ent.inst.destroy && ent.inst.destroy(reason); } catch { /* el panel ya no existe */ }
      ent.frame.remove();
      changed();
    }

    const inSpace = (space) => [...entries.values()].filter((e) => e.tile.space === space);

    function setActiveSpace(space, nextView) {
      activeSpace = space;
      for (const e of entries.values()) e.frame.classList.toggle('other-space', e.tile.space !== space);
      view = nextView && Number.isFinite(nextView.k) ? { x: nextView.x, y: nextView.y, k: clampK(nextView.k) } : { ...HOME };
      applyView();
      const top = inSpace(space).sort((a, b) => b.tile.z - a.tile.z)[0];
      focusedId = null;
      for (const e of entries.values()) e.frame.classList.remove('focused');
      if (top) focus(top.tile.id);
      changed();
    }

    /** Foco al panel siguiente (+1) o anterior (-1) del espacio activo, en orden de creación, y lo trae a la vista. */
    function cycleFocus(dir) {
      const list = inSpace(activeSpace);
      if (!list.length) return;
      const i = list.findIndex((e) => e.tile.id === focusedId);
      const next = list[(i + dir + list.length) % list.length];
      focus(next.tile.id);
      ensureVisible(next.tile);
    }

    return {
      add,
      remove,
      focus,
      setActiveSpace,
      cycleFocus,
      zoomAt,
      zoomBy: (f) => zoomAt(f),
      setZoom,
      fitAll,
      resetView: () => { view = { ...HOME }; applyView(); },
      getView: () => ({ ...view }),
      focused: () => focusedId,
      countIn: (space) => inSpace(space).length,
      /** Cierra todos los paneles de un espacio (los terminales se cierran en el Core). */
      removeSpace: (space) => { for (const e of inSpace(space)) remove(e.tile.id, 'close'); },
      has: (id) => entries.has(id),
      find: (type, pred) => [...entries.values()].find((e) => e.tile.type === type && (!pred || pred(e.tile)))?.tile.id,
      /** Se llama al cerrar la app: libera sin matar nada en el Core. */
      disposeAll: () => { for (const id of [...entries.keys()]) remove(id, 'dispose'); },
      serialize: () => [...entries.values()].map(({ tile }) => ({ id: tile.id, type: tile.type, x: tile.x, y: tile.y, w: tile.w, h: tile.h, z: tile.z, space: tile.space, state: { ...tile.state } })),
      instances: () => [...entries.values()].map((e) => e.inst),
    };
  };
})();
