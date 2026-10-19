// Proceso "wrapper" desacoplado: lanza el agente con su salida a output.log y, al terminar,
// escribe exit.json. Así el Core puede caerse y reengancharse leyendo los archivos.
// Uso: node runner-wrapper.mjs <runDir> <command> [args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [runDir, command, ...args] = process.argv.slice(2);
const outPath = path.join(runDir, 'output.log');
const out = fs.openSync(outPath, 'a');

const finish = (code, signal) => {
  const tmp = path.join(runDir, 'exit.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ code, signal, endedAt: Date.now() }));
  fs.renameSync(tmp, path.join(runDir, 'exit.json'));
  process.exit(0);
};

const child = spawn(command, args, { stdio: ['ignore', out, out], windowsHide: true, env: process.env });
child.on('error', (err) => {
  fs.appendFileSync(outPath, `spawn error: ${err.message}\n`);
  finish(127, null);
});
child.on('spawn', () => fs.writeFileSync(path.join(runDir, 'child.json'), JSON.stringify({ pid: child.pid })));
child.on('exit', (code, signal) => finish(code, signal));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
