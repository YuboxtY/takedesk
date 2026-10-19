'use strict';
// Lienzo de paneles ("tiles"): cada panel es independiente (un agente, un terminal, una revisión, notas),
// se arrastra por su cabecera, se redimensiona por la esquina y recuerda su sitio. Sin innerHTML:
// todo se construye con h() y textContent (los datos de agentes y archivos no son confiables).
(() => {
  const AIW = (window.AIW = window.AIW || {});
  const GRID = 10;
  const MIN_W = 280;
  const MIN_H = 160;
  const snap = (v) => Math.round(v / GRID) * GRID;

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
  };

  /**
   * root: contenedor posicionado. builders: { tipo: (tile, ctx) => { destroy?(reason), onResize?() } }.
   * onChange se llama (sin rebote) cuando cambia posición, tamaño, estado o el conjunto de paneles.
   */
  AIW.createCanvas = function createCanvas(root, { builders, onChange }) {
    const entries = new Map(); // id -> { tile, frame, body, titleEl, actionsEl, inst }
    let zTop = 1;
    let seq = 0;
    let activeSpace = null; // espacio visible; los paneles de otros espacios siguen vivos pero ocultos
    let focusedId = null;
    let timer = null;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onChange && onChange(), 400);
    };

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
        ent.tile.x = Math.max(0, snap(ox + ev.clientX - sx));
        ent.tile.y = Math.max(0, snap(oy + ev.clientY - sy));
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
        ent.tile.w = Math.max(MIN_W, snap(ow + ev.clientX - sx));
        ent.tile.h = Math.max(MIN_H, snap(oh + ev.clientY - sy));
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

    /** Primer hueco sin solapar (recorriendo el área visible por filas); si no hay, en cascada. */
    function freeSpot(w, h, space) {
      const scroller = root.parentElement;
      const maxX = Math.max(w + 40, (scroller ? scroller.clientWidth : 1200) - 20);
      const maxY = Math.max(h + 40, 8000);
      const rects = [...entries.values()].map(({ tile }) => tile).filter((t) => t.space === space);
      const free = (x, y) => rects.every((r) => x + w + 10 <= r.x || r.x + r.w + 10 <= x || y + h + 10 <= r.y || r.y + r.h + 10 <= y);
      for (let y = 20; y + h <= maxY; y += 20) for (let x = 20; x + w <= maxX; x += 20) if (free(x, y)) return { x, y };
      const n = rects.length;
      return { x: 20 + (n % 8) * 30, y: 20 + (n % 8) * 30 };
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

    function setActiveSpace(space) {
      activeSpace = space;
      for (const e of entries.values()) e.frame.classList.toggle('other-space', e.tile.space !== space);
      const vis = inSpace(space);
      const top = vis.sort((a, b) => b.tile.z - a.tile.z)[0];
      focusedId = null;
      for (const e of entries.values()) e.frame.classList.remove('focused');
      if (top) focus(top.tile.id);
      changed();
    }

    /** Foco al panel siguiente (+1) o anterior (-1) del espacio activo, en orden de creación. */
    function cycleFocus(dir) {
      const list = inSpace(activeSpace);
      if (!list.length) return;
      const i = list.findIndex((e) => e.tile.id === focusedId);
      const next = list[(i + dir + list.length) % list.length];
      focus(next.tile.id);
    }

    return {
      add,
      remove,
      focus,
      setActiveSpace,
      cycleFocus,
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
