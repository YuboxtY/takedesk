'use strict';
// El renderer nunca ve el token: pide al proceso principal y este añade la cabecera.
// Solo se permiten rutas /v1/ conocidas (lista blanca) para que un renderer comprometido
// no pueda llamar a cualquier URL.
const ALLOWED = [
  /^\/v1\/health$/,
  /^\/v1\/capabilities$/,
  /^\/v1\/diagnostics$/,
  /^\/v1\/projects$/,
  /^\/v1\/runs(\?[\w=&%.-]*)?$/,
  /^\/v1\/runs\/[\w-]+(\/(cancel|diff|merge|events(\?[\w=&%.-]*)?))?$/,
  /^\/v1\/approvals(\?[\w=&%.-]*)?$/,
  /^\/v1\/approvals\/[\w-]+$/,
];
const METHODS = new Set(['GET', 'POST']);
// Rutas que solo usa el proceso principal (puente de terminales); nunca el renderer.
const INTERNAL = [/^\/v1\/ws-ticket$/, /^\/v1\/terminals(\/[\w-]+)?$/];

function isAllowed(method, pathAndQuery) {
  return METHODS.has(method) && ALLOWED.some((re) => re.test(pathAndQuery));
}

function createProxy({ port, token, fetchFn = fetch, internal = false }) {
  return async function request(method, pathAndQuery, body) {
    const ok = isAllowed(method, pathAndQuery) || (internal && ['GET', 'POST', 'DELETE'].includes(method) && INTERNAL.some((re) => re.test(pathAndQuery)));
    if (!ok) return { status: 403, body: { error: { code: 'forbidden', message: 'Ruta no permitida desde la interfaz' } } };
    const res = await fetchFn(`http://127.0.0.1:${port}${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      /* sin cuerpo */
    }
    return { status: res.status, body: parsed };
  };
}

module.exports = { isAllowed, createProxy };
