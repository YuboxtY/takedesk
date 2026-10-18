# 03 · Arquitectura definitiva

> Fecha: 2026-10-18. Los diagramas completos están en `04-DIAGRAMAS.md`. Esta arquitectura es la **propuesta objetivo**; nada de ella está implementado.

## 1. Principios

1. **Core primero:** toda la lógica vive en un proceso Node independiente. Electron y Android son clientes.
2. **Dos canales independientes:** *canal de agentes* (API propia) y *canal de pantalla* (host remoto). Comparten identidad de dispositivo, no protocolo.
3. **Contratos tipados:** `packages/contracts` es la única fuente de verdad (Zod → TS).
4. **Aislamiento por defecto:** un agente escritor = un worktree.
5. **Humano en el bucle** para merge, comandos riesgosos y acceso remoto nuevo.
6. **Estado reconstruible:** SQLite + archivos de eventos; tras un fallo se reconcilia, no se asume.
7. **No construir lo no validado:** el módulo de visor remoto no existe hasta cerrar el PoC.

## 2. Procesos en tiempo de ejecución (Windows)

| Proceso | Sesión Windows | Responsabilidad | Ciclo de vida |
|---|---|---|---|
| `core` (Node) | **Sesión interactiva del usuario** | API HTTP/WS, scheduler, adaptadores, PTYs, Git, BD | Tarea Programada "al iniciar sesión" + supervisor |
| `supervisor` (Node mínimo) | Usuario | Reinicia `core` con *backoff*; no contiene lógica | Mismo |
| `desktop` (Electron) | Usuario | UI; IPC mínimo para diálogos, bandeja, abrir carpeta | Se abre/cierra libremente |
| Agentes (CLI/SDK) | Usuario | Procesos hijos del Core, con cwd=worktree | Gestionados por Core |
| Host remoto (RustDesk/Sunshine) | Servicio (arranque) + captura de sesión de consola | Pantalla/entrada | Independiente del Core |

**Por qué proceso de usuario y no servicio:** los agentes lanzan navegadores/IDE visibles; un servicio de Windows corre en Session 0, aislada, sin escritorio interactivo (🔎). Consecuencia: **si el usuario cierra sesión, Core y agentes terminan**; si solo bloquea la pantalla (Win+L), siguen. Mitigación opcional: inicio de sesión automático + bloqueo inmediato (riesgo físico → ver `06`).

Distinción de estados (obligatoria en UI):
| Acción | Core | Agentes | Acceso remoto |
|---|---|---|---|
| Cerrar ventana Electron | Sigue | Siguen | Sigue |
| Detener Core | Para | Se cancelan o quedan huérfanos (política) | Sigue |
| Bloquear Windows | Sigue | Siguen | Depende del host (PoC-3) |
| Cerrar sesión de Windows | Muere | Mueren | Solo login screen |
| Suspender/Apagar | No | No | No |

## 3. Estructura del repositorio (cuando se apruebe)

```
apps/desktop            Electron (main, preload mínimo, renderer React)
apps/mobile             Expo Dev Build (RN)
services/core           Fastify, WS, scheduler, composición
packages/contracts      Zod + tipos + versiones de eventos
packages/domain         entidades y reglas puras (sin E/S)
packages/agent-adapters Claude, Codex, ACP, OpenCode (+ fixtures por versión)
packages/orchestrator   planner schema, DAG, scheduler, FSM
packages/git-engine     worktrees, diff, merge, limpieza
packages/database       Drizzle schema, migraciones, repositorios
packages/security       pairing, firmas, políticas, auditoría, secretos
packages/ui-web         componentes compartidos de desktop
tests/e2e               Playwright + escenarios
docs/                   estos documentos + ADRs
# packages/remote-bridge → NO se crea hasta cerrar PoC
```

**Reglas de dependencia (verificables en CI con `dependency-cruiser`/ESLint boundaries):**
`contracts` y `domain` no dependen de nada; `apps/*` no importan `services/*`; `agent-adapters` no importan `database`; solo `services/core` compone. Ver diagrama 15.

## 4. Contratos

* **Versionado:** `apiVersion` en rutas (`/v1`), y `schemaVersion` en cada evento. Compatibilidad cliente↔servidor negociada en `GET /v1/health` (`minClient`, `serverVersion`). Android antiguo → mensaje "actualiza la app".
* **Eventos:** `{ eventId (monótono por Core), ts, scope {projectId, taskId?, runId?}, type, v, payload }`. Cliente guarda `lastEventId`; al reconectar pide `?since=`. Core conserva ventana de eventos recientes en BD/NDJSON; si el hueco es mayor, ordena *resync* (snapshot).
* **Backpressure WS:** límite de tamaño de mensaje, cola por cliente con descarte de `agent.output.delta` intermedios (colapsando en chunks) pero **nunca** de eventos de estado/aprobación.
* **Idempotencia:** comandos mutadores aceptan `Idempotency-Key`.
* **API del documento** (`/v1/health`, `/projects`, `/tasks`, `/runs`, `/runs/:id/cancel`, `/approvals/:id`, `/runs/:id/events`, `WS /v1/events`) se conserva y se completa en `05`.

## 5. Adaptadores de agentes

### 5.1 Interfaz de dominio

```ts
interface AgentAdapter {
  readonly id: 'claude' | 'codex' | 'gemini' | 'opencode' | string;
  probe(): Promise<AdapterInfo>;                 // versión, instalado, autenticado, capabilities
  start(req: StartRequest): Promise<RunHandle>;  // cwd=worktree, prompt, límites, modo de permisos
  events(run: RunHandle): AsyncIterable<AgentEvent>;
  respondToApproval?(run: RunHandle, id: string, d: Decision): Promise<void>; // solo si capability
  cancel(run: RunHandle, mode: 'graceful' | 'force'): Promise<void>;
  recover(runId: string): Promise<RecoverResult>; // 'reattached' | 'resumable' | 'unsupported'
}

interface Capabilities {
  interactiveApprovals: boolean;
  resume: 'native' | 'context-only' | 'none';
  structuredEvents: boolean;
  reportsCost: boolean;
  planMode: boolean;
  subagents: boolean;
}
```

Cada adaptador **normaliza** a `AgentEvent` (`output.delta`, `tool.started/finished`, `approval.requested`, `usage`, `run.finished`, `error`) y conserva el evento crudo en `payload.raw` para depuración. La UI **solo muestra acciones soportadas** según `capabilities`.

### 5.2 Implementaciones

| Adaptador | Mecanismo | Aprobaciones | Recuperación |
|---|---|---|---|
| `claude` | `claude-agent-sdk` `query()` en streaming; `canUseTool` → `approval.requested`; `abortController`/`interrupt()` | Sí | `resume` con `sessionId` guardado; transcript local |
| `codex-exec` | `codex exec --json`, JSONL; `exec resume` | No (sandbox por flag) | `thread_id` guardado |
| `codex-appserver` | JSON-RPC stdio: `initialize`, `thread/start`, `turn/start`; responde requests de aprobación | Sí | `thread/resume` |
| `acp` | JSON-RPC stdio (`gemini --acp`, `opencode acp` 🔎, bridges) | Sí (según agente) | `loadSession` si capability |
| `opencode-server` | `opencode serve` (loopback+password) + SDK; SSE `/event` | Sí (`/permissions`) | Sesiones persistidas por OpenCode |
| `generic-pty` (último recurso) | PTY + parser | No | No |

**Estabilidad frente a cambios de CLI:** `probe()` registra la versión; fixtures de salida real por versión en `agent-adapters/__fixtures__`; *contract tests* en CI nocturno contra CLIs instalados; si un CLI actualiza y rompe, el adaptador marca `degraded` en vez de fallar silenciosamente.

### 5.3 Permisos y seguridad del agente
Modo por defecto `default` (pregunta) o `plan`. `bypassPermissions` / "dangerously-skip" **solo** dentro de un sandbox desechable y nunca disponible desde Android. Reglas de denegación globales (p. ej. `rm -rf`, `git push --force`, acceso fuera del worktree) se aplican también en el adaptador (`disallowedTools` en Claude ✅).

## 6. Orquestación (motor propio)

```
Solicitud → Coordinador(read-only) → Plan JSON (Zod) → [Aprobación humana]
        → Scheduler(DAG, recursos, cuotas) → Runs en worktrees → Revisor(tests/lint/diff)
        → ¿falla? → tarea de corrección (máx. N intentos) → Integration Manager (merge secuencial, aprobado)
```
* `Plan`: `{ tasks: [{ id, title, goal, files?, dependsOn[], agentProfile, kind: 'read'|'write'|'test', estCost? }] }`. Validar: sin ciclos, sin rutas fuera del repo, `dependsOn` existente.
* **Detección de solapamiento:** si dos tareas escritoras declaran los mismos archivos, el planificador las **serializa** (dependencia implícita).
* **Presupuesto:** máx. intentos, máx. tiempo, máx. coste estimado por plan; al exceder → pausa y pregunta.
* **Salvaguardas contra bucles:** profundidad máxima de re-planificación; el coordinador no puede crear tareas fuera del plan aprobado sin nueva aprobación.
* **Integración:** merge **secuencial**, cada uno en una rama de integración; tests tras cada merge; el merge final a la rama del usuario es siempre manual (botón + diff).

## 7. Planificador de recursos y concurrencia
Entradas: RAM libre, CPU (carga 1 min), nº de runs por proveedor, 429 recientes. Regla: iniciar si `ram_libre > reserva + estimación(perfil)`, `semaforo[proveedor] > 0` y `activos < max_configurado`. Estimación inicial por proveedor se **mide** (PoC-6) y se ajusta con media móvil. **Valores iniciales para el equipo del usuario (16 GB RAM, ~63 GB libres): máx. 3 runs simultáneos, reserva de 3 GB de RAM, no iniciar con < 15 GB de disco libre y cuota de worktrees de 15 GB** (ver `08` §6; son puntos de partida, no resultados). Reintentos con *backoff* exponencial solo para errores transitorios (red/429), nunca para fallos de lógica.

## 8. Git
* `git` CLI con `spawn` (argv, nunca shell). `GIT_TERMINAL_PROMPT=0`.
* Rama `task/<taskId>-<slug>`; worktree en `%LOCALAPPDATA%\AIWorkspace\worktrees\<projectId>\<taskId>`; baseCommit guardado.
* Antes de crear: `git status --porcelain` del repo origen (no se sobrescribe nada del usuario).
* 🧪 Verificado: worktrees concurrentes, conflicto detectable, `worktree remove` rechaza sucios.
* **Windows:** rutas largas (`core.longpaths`), antivirus y bloqueo de archivos al borrar; `node_modules` por worktree (usar store de pnpm; coste disco). 
* **Limpieza:** solo si run finalizado y `git status` limpio o cambios ya convertidos en commit/rama; `git worktree prune` periódico; cuota de disco total de worktrees.

## 9. Persistencia

**Tablas** (extendiendo el documento): `project`, `workspace`, `agent_profile`, `task`, `task_dependency`, `plan` (versión del plan), `agent_run`, `worktree`, `agent_event_index`, `conversation`, `message`, `approval`, `review`, `git_ref`, `trusted_device`, `pairing_code`, `remote_session`, `audit_log`, `setting`, `backup_job`, `schema_migration`.

**Datos grandes fuera de la BD:** `agent_event` completos y salidas de terminal → archivos NDJSON por run (`data/runs/<runId>/events.ndjson`, comprimidos al cerrar) + en SQLite solo `agent_event_index` (seq, kind, offset, resumen truncado).

**Retención (configurable, valores iniciales):** eventos de runs finalizados 30 días en detalle → luego solo resumen; salidas de terminal 7 días; `audit_log` 1 año (pequeño, recorte por tamaño); artefactos de pruebas 14 días; conversaciones indefinidas pero con *compactación* de adjuntos. Job diario `retention` con límites de tiempo y transacciones pequeñas; `PRAGMA incremental_vacuum`/`VACUUM INTO` mensual.

**Crecimiento:** estimar con PoC-7 (insertar N eventos/día simulados × 365 días y medir tamaño/índices/consultas). Objetivo: BD < 1 GB tras 3 años con la retención por defecto; **es un objetivo a verificar, no una promesa**.

**SQLite:** `journal_mode=WAL`, `synchronous=NORMAL` (FULL para tablas críticas si se prefiere), `foreign_keys=ON`, `busy_timeout`, un **único escritor** (cola en Core), lectores concurrentes. Backups: API de backup/`VACUUM INTO`, nunca copiar `-wal` en caliente (✅ el documento coincide). Migraciones: Drizzle + tabla `schema_migration`, backup automático antes de migrar, rollback restaurando copia.

## 10. Recuperación ante fallos

1. Al arrancar Core: marcar runs `running` previos como `pending_reconciliation`.
2. Reconciliar: por `pid + start time` (evitar reutilización de PID) y/o reconexión del adaptador (`recover()`):
   * proceso vivo → `reattached`;
   * adaptador con `resume` → `resumable` (nueva run enlazada);
   * nada → `interrupted` (**nunca** `completed` sin evidencia, CA-08).
3. Worktrees huérfanos: listar `git worktree list` vs tabla `worktree`; quedan en "revisión" no se borran.
4. Verificación de integridad: `PRAGMA quick_check` al arrancar; fallo → modo solo lectura + oferta de restaurar backup.
5. Supervisor reinicia Core con *backoff* y límite de reinicios/min; tras N fallos notifica y se detiene (evita bucle de caídas).

## 11. Observabilidad
Logger estructurado con **redacción de secretos** (lista de claves + patrones), métricas en memoria (CPU/RAM por proceso, runs activos, throughput de eventos, tamaño de BD y de logs, latencia API), `GET /v1/diagnostics/export` que genera paquete **sin secretos**. Alertas locales (bandeja/notificación) para disco bajo, BD grande, runs colgados (sin eventos > umbral).

## 12. UI (ver `05` para pantallas)
Desktop: barra superior, panel izquierdo (explorador/tareas/agentes/Git/historial), centro (Monaco/navegador/lienzo/tabs), derecho (sesiones IA/permisos), inferior (terminales/logs/pruebas). Android: Inicio, PC, Agentes, Tareas, Ajustes; vista horizontal inmersiva para escritorio remoto. Mockups ≠ implementación.

## 13. Evolución
Nuevo proveedor = nuevo adaptador + fixtures + test de contrato; sin tocar Core ni UI salvo `capabilities`. Nuevo cliente = consume `contracts`. Nuevo host remoto = módulo `remote-bridge` tras PoC.
