'use strict';
// Apariencia: fondo del lienzo (por espacio) y tema claro/oscuro/sistema (global).
(() => {
  const AIW = window.AIW;
  const h = AIW.h;
  const api = window.aiw;

  const KINDS = [['dots', 'Puntos'], ['grid', 'Cuadrícula'], ['lines', 'Líneas'], ['plain', 'Liso'], ['gradient', 'Degradado'], ['image', 'Imagen']];
  const GRADIENTS = {
    aurora: ['Aurora', 'linear-gradient(135deg, #0f2027, #203a43 50%, #2c5364)'],
    sunset: ['Atardecer', 'linear-gradient(135deg, #2b1055, #7597de 120%)'],
    ocean: ['Océano', 'linear-gradient(160deg, #031b34, #0b4f6c 55%, #20a4a0)'],
    graphite: ['Grafito', 'linear-gradient(135deg, #16181d, #2a2f38)'],
    paper: ['Papel', 'linear-gradient(135deg, #f6f1e7, #e4dccb)'],
  };
  const THEMES = [['system', 'Sistema'], ['dark', 'Oscuro'], ['light', 'Claro']];
  const imageCache = new Map();
  let ctx = null; // { getBg(), setBg(bg), getTheme(), setTheme(t) }
  let open = false;

  async function imageUrl(name) {
    if (!imageCache.has(name)) imageCache.set(name, await api.bg.load(name));
    return imageCache.get(name);
  }

  /** Aplica el fondo al lienzo. */
  async function apply(bg) {
    const el = document.getElementById('canvas-scroll');
    const b = bg || { kind: 'dots' };
    for (const c of [...el.classList]) if (c.startsWith('bg-')) el.classList.remove(c);
    el.classList.add(`bg-${b.kind}`);
    if (b.color) el.style.setProperty('--bgc', b.color); else el.style.removeProperty('--bgc');
    el.style.removeProperty('--bgimg');
    if (b.kind === 'gradient') {
      el.style.setProperty('--bgimg', (GRADIENTS[b.gradient] || GRADIENTS.aurora)[1]);
    } else if (b.kind === 'image') {
      const url = b.image ? await imageUrl(b.image) : null;
      const dim = Number.isFinite(b.dim) ? b.dim : 0.35;
      if (url) el.style.setProperty('--bgimg', `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${url}")`);
      else el.classList.replace('bg-image', 'bg-plain'); // imagen perdida: cae a liso en vez de romperse
    }
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (!theme || theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
  }

  async function render() {
    const menu = document.getElementById('bg-menu');
    menu.hidden = !open;
    if (!open) return;
    const bg = ctx.getBg() || { kind: 'dots' };
    const set = (patch) => { ctx.setBg({ ...bg, ...patch }); apply(ctx.getBg()); render(); };

    const kindRow = h('div', { className: 'bg-kinds' }, ...KINDS.map(([k, label]) => h('button', {
      className: 'bg-kind' + (bg.kind === k ? ' active' : ''), textContent: label, data: { bgKind: k },
      on: { click: () => set({ kind: k }) },
    })));

    const color = h('input', { type: 'color', className: 'bg-color', value: bg.color || '#0b0d11', title: 'Color base' });
    color.addEventListener('input', () => set({ color: color.value }));
    const resetColor = h('button', { textContent: 'Color por defecto', on: { click: () => { const { color: _c, ...rest } = bg; ctx.setBg(rest); apply(ctx.getBg()); render(); } } });

    const parts = [h('h3', { textContent: 'Fondo de este espacio' }), kindRow, h('div', { className: 'row' }, h('label', { textContent: 'Color ' }, color), resetColor)];

    if (bg.kind === 'gradient') {
      parts.push(h('div', { className: 'bg-kinds' }, ...Object.entries(GRADIENTS).map(([id, [label, css]]) => h('button', {
        className: 'bg-swatch' + ((bg.gradient || 'aurora') === id ? ' active' : ''), title: label, data: { bgGradient: id },
        attrs: { style: `background:${css}` }, textContent: label, on: { click: () => set({ gradient: id }) },
      }))));
    }

    if (bg.kind === 'image') {
      const names = await api.bg.list();
      const msg = h('span', { className: 'msg' });
      const dim = h('input', { type: 'range', min: '0', max: '0.8', step: '0.05', value: String(Number.isFinite(bg.dim) ? bg.dim : 0.35), className: 'bg-dim' });
      dim.addEventListener('input', () => { ctx.setBg({ ...bg, dim: Number(dim.value) }); apply(ctx.getBg()); });
      const thumbs = await Promise.all(names.map(async (n) => {
        const url = await imageUrl(n);
        const del = h('button', { className: 'bg-thumb-del', textContent: '×', title: 'Eliminar de las imágenes guardadas', on: { click: async (e) => {
          e.stopPropagation();
          if (ctx.imageInUse(n)) { msg.textContent = 'Esa imagen está en uso en algún espacio.'; msg.classList.add('bad'); return; }
          await api.bg.remove(n);
          imageCache.delete(n);
          render();
        } } });
        return h('span', { className: 'bg-thumb-wrap' }, h('button', { className: 'bg-thumb' + (bg.image === n ? ' active' : ''), data: { bgImage: n }, title: 'Usar esta imagen', attrs: { style: `background-image:url("${url}")` }, on: { click: () => set({ image: n }) } }), del);
      }));
      parts.push(
        h('div', { className: 'row' }, h('button', { textContent: 'Elegir imagen…', className: 'bg-pick', on: { click: async () => {
          const r = await api.bg.pick();
          if (!r) return;
          if (r.error) { msg.textContent = r.error; msg.classList.add('bad'); return; }
          set({ image: r.name });
        } } }), msg),
        h('div', { className: 'bg-thumbs' }, ...thumbs),
        h('label', { textContent: 'Oscurecer para leer mejor ' }, dim),
      );
    }

    const themeSel = h('select', { className: 'theme-select' }, ...THEMES.map(([v, label]) => h('option', { value: v, textContent: label })));
    themeSel.value = ctx.getTheme() || 'system';
    themeSel.addEventListener('change', () => { ctx.setTheme(themeSel.value); applyTheme(themeSel.value); });
    parts.push(h('h3', { textContent: 'Tema de la aplicación' }), h('div', { className: 'row' }, themeSel));
    menu.replaceChildren(...parts);
  }

  function mount(context) {
    ctx = context;
    const btn = document.getElementById('bg-btn');
    btn.addEventListener('click', (e) => { e.stopPropagation(); open = !open; render(); });
    document.addEventListener('pointerdown', (e) => {
      if (open && !e.target.closest('#bg-menu, #bg-btn')) { open = false; render(); }
    }, true);
    window.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { open = false; render(); } });
  }

  AIW.appearance = { mount, apply, applyTheme, refresh: () => { if (open) render(); } };
})();
