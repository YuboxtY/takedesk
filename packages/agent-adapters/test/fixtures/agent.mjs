import { spawn } from 'node:child_process';

const mode = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));

if (mode === 'ok') {
  out({ kind: 'session', externalSessionId: 'sess-1' });
  out({ kind: 'output.delta', text: 'hola' });
  console.log('linea plana');
  out({ kind: 'run.finished', ok: true });
} else if (mode === 'fail') {
  console.log('boom');
  process.exit(3);
} else if (mode === 'slow') {
  const n = Number(process.argv[3] ?? 10);
  let i = 0;
  const t = setInterval(() => {
    out({ kind: 'output.delta', text: `tick ${++i}` });
    if (i >= n) { clearInterval(t); process.exit(0); }
  }, 100);
} else if (mode === 'hang') {
  const g = spawn('sleep', ['60'], { stdio: 'ignore' });
  out({ kind: 'output.delta', text: `grandchild ${g.pid}` });
  setInterval(() => {}, 1000);
}
