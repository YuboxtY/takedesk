// Prueba manual de extremo a extremo: lanza OpenCode real vía el adaptador (shim .cmd incluido).
// Uso: pnpm --filter @aiw/core exec tsx scripts/e2e-opencode.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenCodeAdapter } from '@aiw/agent-adapters';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-e2e-'));
fs.writeFileSync(path.join(tmp, 'a.txt'), 'hola mundo');
const a = createOpenCodeAdapter();
console.log('probe', await a.probe());
const s = await a.start({ runId: 'e2e', cwd: tmp, prompt: 'Lee a.txt y dime su contenido en una frase.', mode: 'read', runDir: path.join(tmp, 'run') });
for await (const e of s.events) console.log(JSON.stringify(e).slice(0, 200));
