import fs from 'node:fs';
import path from 'node:path';
import { FakeAdapter, createClaudeAdapter, createOpenCodeAdapter, type AgentAdapter } from '@aiw/agent-adapters';
import { applyRetention, createRepos, openDatabase } from '@aiw/database';
import { loadOrCreateToken } from './auth';
import { loadConfig } from './config';
import { EventBus } from './event-bus';
import { PtyManager } from './pty-manager';
import { systemProbe } from './resources';
import { MergeService } from './merge-service';
import { RunManager } from './run-manager';
import { buildServer } from './server';

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const token = loadOrCreateToken(cfg.dataDir);
  const database = openDatabase(cfg.dbFile);
  const repos = createRepos(database.db);
  const bus = new EventBus(repos);

  // Adaptadores reales instalados (Claude, OpenCode). Codex y Antigravity: pendientes (no están en PATH).
  // Un adaptador cuyo CLI no existe se registra igual: el Core informa "no instalado" en la sonda.
  const adapters = new Map<string, AgentAdapter>([
    ['claude', createClaudeAdapter()],
    ['opencode', createOpenCodeAdapter()],
  ]);
  if (process.env.AIW_ENABLE_FAKE === '1') adapters.set('fake', new FakeAdapter());

  const pty = new PtyManager({ shell: cfg.shell, maxSessions: cfg.maxTerminals });
  const runs = new RunManager({ repos, bus, adapters, cfg, probe: systemProbe });
  const merges = new MergeService({ repos, bus });
  const rec = await runs.reconcile();

  const app = await buildServer({ cfg, repos, bus, runs, merges, pty, adapters, token, probe: systemProbe, logger: true });
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info({ reconcile: rec, dataDir: cfg.dataDir, tokenFile: path.join(cfg.dataDir, 'api-token') }, 'Core listo');

  const retention = () => {
    try { app.log.info(applyRetention(repos, Date.now(), cfg.retention), 'retención aplicada'); } catch (e) { app.log.error(e, 'retención falló'); }
  };
  retention();
  setInterval(retention, 6 * 3600_000).unref();

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, 'deteniendo Core (los agentes desacoplados siguen vivos; los terminales se cierran)');
    await app.close();
    runs.shutdown();
    pty.killAll();
    database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('Core no pudo iniciar:', e instanceof Error ? e.message : e);
  process.exit(1);
});
