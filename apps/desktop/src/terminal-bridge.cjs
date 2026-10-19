'use strict';
// Puente entre el renderer (xterm) y los terminales del Core. El WebSocket y el ticket viven en el
// proceso principal; el renderer solo intercambia datos por IPC. Cerrar la app o el socket NO mata
// el terminal (CA-03): el Core lo conserva y, al reconectar, reenvía el scrollback.

function createTerminalBridge({ request, port, send, WebSocketImpl = globalThis.WebSocket }) {
  /** id -> WebSocket */
  const sockets = new Map();

  async function list() {
    const r = await request('GET', '/v1/terminals');
    return r.status === 200 ? r.body.terminals : [];
  }

  async function open(projectId, cols, rows) {
    const r = await request('POST', '/v1/terminals', { projectId, cols, rows });
    if (r.status !== 201) throw new Error(r.body && r.body.error ? r.body.error.message : `Error ${r.status}`);
    return r.body;
  }

  async function attach(id) {
    detach(id);
    const t = await request('POST', '/v1/ws-ticket');
    if (t.status !== 200) throw new Error('No se pudo obtener el ticket del terminal');
    const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/v1/terminals/${encodeURIComponent(id)}/ws?ticket=${encodeURIComponent(t.body.ticket)}`);
    sockets.set(id, ws);
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'data') send('term:data', id, msg.data);
      else if (msg.type === 'exit') send('term:exit', id, msg.exitCode);
    });
    ws.addEventListener('close', () => {
      if (sockets.get(id) === ws) sockets.delete(id);
      send('term:closed', id);
    });
    ws.addEventListener('error', () => { /* 'close' informa */ });
  }

  function detach(id) {
    const ws = sockets.get(id);
    sockets.delete(id);
    if (ws) try { ws.close(); } catch { /* ya cerrado */ }
  }

  function input(id, data) {
    const ws = sockets.get(id);
    if (ws && ws.readyState === 1 && typeof data === 'string' && data.length <= 65536) ws.send(JSON.stringify({ type: 'input', data }));
  }

  function resize(id, cols, rows) {
    const ws = sockets.get(id);
    if (ws && ws.readyState === 1 && Number.isInteger(cols) && Number.isInteger(rows)) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  async function kill(id) {
    detach(id);
    await request('DELETE', `/v1/terminals/${encodeURIComponent(id)}`);
  }

  /** Solo cierra los sockets (los terminales siguen vivos en el Core). */
  function dispose() {
    for (const id of [...sockets.keys()]) detach(id);
  }

  return { list, open, attach, detach, input, resize, kill, dispose };
}

module.exports = { createTerminalBridge };
