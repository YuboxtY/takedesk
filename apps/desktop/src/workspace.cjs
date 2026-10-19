'use strict';
// El workspace (qué paneles hay y dónde) viene del renderer: se sanea antes de escribirlo a disco.
const TYPES = new Set(['terminal', 'agent', 'review', 'notes']);
const MAX_TILES = 40;
const MAX_STR = 20000;

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
  if (Array.isArray(w.layout)) {
    out.layout = w.layout
      .filter((t) => t && typeof t === 'object' && TYPES.has(t.type))
      .slice(0, MAX_TILES)
      .map((t) => ({
        id: typeof t.id === 'string' && /^[\w-]{1,60}$/.test(t.id) ? t.id : undefined,
        type: t.type,
        x: num(t.x, 0, 20000, 20),
        y: num(t.y, 0, 20000, 20),
        w: num(t.w, 280, 4000, 520),
        h: num(t.h, 160, 4000, 360),
        z: num(t.z, 1, 100000, 1),
        state: cleanState(t.state),
      }));
  }
  return out;
}

module.exports = { sanitizeWorkspace };
