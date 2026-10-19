'use strict';
// Normaliza lo que se escribe en la barra de direcciones del panel Navegador.
// Solo se admiten http y https (más about:blank): file:, javascript:, data:, etc. se rechazan.
(() => {
  const SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;
  const DANGEROUS = /^(javascript|data|file|blob|vbscript|chrome|devtools|view-source|about):/i;
  const HOSTLIKE = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+)(:\d{1,5})?([/?#].*)?$/i;
  const LOCAL = /^(localhost|127\.|10\.|192\.168\.|\[::1\]|[\w.-]+\.(local|localhost|test)(:|\/|$))/i;

  function normalizeUrl(input) {
    const text = String(input ?? '').trim();
    if (!text) return { error: 'Escribe una dirección o una búsqueda' };
    if (text === 'about:blank') return { url: text };
    if (/^https?:\/\//i.test(text)) {
      try {
        const u = new URL(text);
        return u.hostname ? { url: u.href } : { error: 'Dirección no válida' };
      } catch {
        return { error: 'Dirección no válida' };
      }
    }
    if (SCHEME_WITH_SLASHES.test(text) || DANGEROUS.test(text)) return { error: 'Solo se admiten direcciones http y https' };
    if (!/\s/.test(text) && HOSTLIKE.test(text)) {
      try {
        return { url: new URL((LOCAL.test(text) ? 'http://' : 'https://') + text).href };
      } catch {
        return { error: 'Dirección no válida' };
      }
    }
    return { url: 'https://duckduckgo.com/?q=' + encodeURIComponent(text) };
  }

  const api = { normalizeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.AIW = window.AIW || {}).url = api;
})();
