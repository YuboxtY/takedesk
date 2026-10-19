# AI Workspace

Plataforma personal para ejecutar varios agentes de programación en paralelo (Claude Code, Codex,
OpenCode, Antigravity), coordinarlos y controlar la PC Windows desde un móvil Android.

> **Estado: en construcción, solo el backend (Core) existe.** No hay interfaz de escritorio, app
> Android ni adaptadores de agentes reales todavía. Lee `docs/` (empieza por `01` y `07`).

## Qué hay hoy

| Paquete | Qué hace |
|---|---|
| `packages/contracts` | Esquemas Zod: eventos, estados, API |
| `packages/domain` | Máquina de estados de runs, redacción de secretos |
| `packages/platform` | Todo lo específico del SO (árbol de procesos, rutas, recursos). Ramas de Windows **sin validar** |
| `packages/database` | SQLite (WAL) + Drizzle: migraciones con backup previo, backups verificados, retención, log NDJSON |
| `packages/git-engine` | Worktrees, diff, merge seguro (aborta ante conflicto) |
| `packages/agent-adapters` | Interfaz común, adaptador simulado y adaptador de procesos desacoplados |
| `services/core` | API HTTP/WebSocket, cola de runs con límites de recursos y cuota, aprobaciones, terminales (PTY), reconciliación tras caídas, supervisor |

## Uso (desarrollo)

```bash
pnpm install
pnpm verify          # límites de módulos + tipos + pruebas
AIW_ENABLE_FAKE=1 pnpm core   # arranca el Core en 127.0.0.1:47821 con un agente simulado
```

El token de la API se crea en `<datos>/api-token` (Linux: `~/.local/share/aiworkspace`; Windows:
`%LOCALAPPDATA%\AIWorkspace`). Variables: `AIW_DATA_DIR`, `AIW_PORT`, `AIW_MAX_RUNS` (3),
`AIW_MAX_RUNS_PER_PROVIDER` (2), `AIW_MIN_FREE_DISK_GB` (15), `AIW_RESERVE_MEM_GB` (3).

Los valores por defecto están pensados para un portátil de 16 GB de RAM y ~63 GB de disco libre.

## Qué NO está verificado
Windows, Android, Electron, agentes reales, escritorio remoto, carga prolongada. Ver `docs/07` (estado por criterio de aceptación) y `docs/09`.
