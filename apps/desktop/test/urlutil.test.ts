import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { normalizeUrl } = require('../renderer/urlutil.js');

describe('normalizeUrl (barra de direcciones del navegador)', () => {
  it('añade esquema: http a lo local, https al resto', () => {
    expect(normalizeUrl('localhost:3000').url).toBe('http://localhost:3000/');
    expect(normalizeUrl('127.0.0.1:8080/app').url).toBe('http://127.0.0.1:8080/app');
    expect(normalizeUrl('192.168.1.5:5173').url).toBe('http://192.168.1.5:5173/');
    expect(normalizeUrl('mi-app.local/x').url).toBe('http://mi-app.local/x');
    expect(normalizeUrl('example.com').url).toBe('https://example.com/');
    expect(normalizeUrl('docs.example.com/a?b=1#c').url).toBe('https://docs.example.com/a?b=1#c');
  });
  it('respeta http(s) completo y about:blank', () => {
    expect(normalizeUrl('https://example.com/x').url).toBe('https://example.com/x');
    expect(normalizeUrl('http://localhost:3000').url).toBe('http://localhost:3000/');
    expect(normalizeUrl('about:blank').url).toBe('about:blank');
  });
  it('rechaza esquemas peligrosos', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<script>1</script>', 'view-source:https://x.com', 'chrome://settings', 'ftp://x.com', 'blob:https://x.com/1', 'about:config', 'devtools://devtools/bundled/inspector.html']) {
      expect(normalizeUrl(bad).error, bad).toBeTruthy();
      expect(normalizeUrl(bad).url, bad).toBeUndefined();
    }
  });
  it('convierte texto libre en búsqueda y rechaza lo vacío', () => {
    expect(normalizeUrl('cómo usar git worktree').url).toBe('https://duckduckgo.com/?q=' + encodeURIComponent('cómo usar git worktree'));
    expect(normalizeUrl('hola').url).toMatch(/^https:\/\/duckduckgo\.com\/\?q=hola$/);
    expect(normalizeUrl('   ').error).toBeTruthy();
    expect(normalizeUrl(null).error).toBeTruthy();
  });
});
