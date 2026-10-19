// Verifica las reglas de dependencia entre módulos (docs/04-DIAGRAMAS.md, diagrama 15) mirando
// los imports reales del código, no solo los package.json. Falla con código 1 si hay violaciones.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Dependencias permitidas por módulo. Todo lo no listado está prohibido. */
export const ALLOWED = {
  contracts: [],
  domain: ['contracts'],
  platform: [],
  'git-engine': [],
  database: ['contracts', 'domain'],
  'agent-adapters': ['contracts', 'domain', 'platform'],
  core: ['contracts', 'domain', 'platform', 'database', 'git-engine', 'agent-adapters'],
};

const DIRS = { contracts: 'packages/contracts', domain: 'packages/domain', platform: 'packages/platform', 'git-engine': 'packages/git-engine', database: 'packages/database', 'agent-adapters': 'packages/agent-adapters', core: 'services/core' };

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'drizzle') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js)$/.test(e.name)) yield p;
  }
}

export function collectEdges() {
  const edges = [];
  for (const [mod, dir] of Object.entries(DIRS)) {
    const abs = path.join(root, dir);
    for (const file of walk(abs)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]@aiw\/([a-z-]+)['"]/g)) {
        edges.push({ from: mod, to: m[1], file: path.relative(root, file) });
      }
    }
  }
  return edges;
}

export function check() {
  const errors = [];
  const edges = collectEdges();
  for (const e of edges) {
    if (e.to === e.from) continue;
    if (!(e.to in ALLOWED)) errors.push(`${e.file}: importa @aiw/${e.to}, que no es un módulo conocido`);
    else if (!ALLOWED[e.from].includes(e.to)) errors.push(`${e.file}: ${e.from} no puede depender de ${e.to}`);
  }
  // package.json debe declarar exactamente lo permitido (ni de más ni de menos respecto a los imports)
  for (const [mod, dir] of Object.entries(DIRS)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const declared = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@aiw/')).map((d) => d.slice(5));
    const used = new Set(edges.filter((e) => e.from === mod && e.to !== mod).map((e) => e.to));
    for (const d of declared) if (!ALLOWED[mod].includes(d)) errors.push(`${dir}/package.json: declara @aiw/${d}, prohibido para ${mod}`);
    for (const u of used) if (!declared.includes(u)) errors.push(`${dir}/package.json: usa @aiw/${u} sin declararlo`);
  }
  // ciclos
  const graph = Object.fromEntries(Object.keys(ALLOWED).map((m) => [m, [...new Set(edges.filter((e) => e.from === m && e.to !== m).map((e) => e.to))]]));
  const state = {};
  const visit = (n, stack) => {
    if (state[n] === 2) return;
    if (state[n] === 1) { errors.push(`ciclo de dependencias: ${[...stack, n].join(' -> ')}`); return; }
    state[n] = 1;
    for (const d of graph[n] ?? []) visit(d, [...stack, n]);
    state[n] = 2;
  };
  for (const n of Object.keys(graph)) visit(n, []);
  return { errors, edges: edges.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { errors, edges } = check();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`límites de módulos OK (${edges} imports revisados)`);
}
