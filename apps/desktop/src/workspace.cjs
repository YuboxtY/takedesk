'use strict';
// El workspace (qué paneles hay y dónde) viene del renderer: se sanea antes de escribirlo a disco.
const TYPES = new Set(['terminal', 'agent', 'review', 'notes', 'browser', 'editor', 'apps']);
const MAX_TILES = 40;
const MAX_STR = 20000;
const MAX_SPACES = 12;
const ID = /^[\w-]{1,60}$/;

const num = (v, min, max, d) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);

function cleanState(state) {
  const out = {};
  if (!state || typeof state !== 'object') return out;
  for (const [k, v] of Object.entries(state).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_STR);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function sanitizeWorkspace(w) {
  const out = {};
  if (!w || typeof w !== 'object') return out;
  if (typeof w.projectId === 'string' && w.projectId.length < 200) out.projectId = w.projectId;
  if (Array.isArray(w.spaces)) {
    const seen = new Set();
    out.spaces = w.spaces
      .filter((sp) => sp && typeof sp === 'object' && typeof sp.id === 'string' && ID.test(sp.id) && !seen.has(sp.id) && seen.add(sp.id))
      .slice(0, MAX_SPACES)
      .map((sp) => {
        const v = sp.view;
        const view = v && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.k)
          ? { x: Math.min(1e6, Math.max(-1e6, v.x)), y: Math.min(1e6, Math.max(-1e6, v.y)), k: Math.min(3, Math.max(0.1, v.k)) }
          : undefined;
        return { id: sp.id, name: (typeof sp.name === 'string' ? sp.name.trim() : '').slice(0, 40) || 'Espacio', view };
      });
  }
  if (typeof w.activeSpace === 'string' && ID.test(w.activeSpace)) out.activeSpace = w.activeSpace;
  if (Array.isArray(w.layout)) {
    out.layout = w.layout
      .filter((t) => t && typeof t === 'object' && TYPES.has(t.type))
      .slice(0, MAX_TILES)
      .map((t) => ({
        id: typeof t.id === 'string' && ID.test(t.id) ? t.id : undefined,
        space: typeof t.space === 'string' && ID.test(t.space) ? t.space : undefined,
        type: t.type,
        x: num(t.x, -1e5, 1e5, 20),
        y: num(t.y, -1e5, 1e5, 20),
        w: num(t.w, 280, 4000, 520),
        h: num(t.h, 160, 4000, 360),
        z: num(t.z, 1, 100000, 1),
        state: cleanState(t.state),
      }));
  }
  return out;
}

module.exports = { sanitizeWorkspace };
