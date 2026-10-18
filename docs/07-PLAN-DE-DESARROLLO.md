# 07 · Plan de desarrollo

> Fecha: 2026-10-18. Tiempos = **estimaciones orientativas** para una persona con asistencia de IA, trabajo constante (~25–35 h/semana). No son compromisos. Rangos amplios donde hay incertidumbre.
> Regla general: **ninguna etapa se da por terminada sin sus criterios de aceptación ejecutados** (no basta que compile). Cada etapa termina con demo + registro de resultados en `09`.
> **Puerta 0:** no se crea la estructura del monorepo hasta que apruebes este plan.

## Vista general

| Etapa | Nombre | Duración est. | Puerta de salida |
|---|---|---|---|
| 0 | Validación de viabilidad (PoC remoto + base técnica) | 1–2 sem | Elegir host remoto; cerrar D-01…D-04 |
| 1 | Base: Core + Electron mínimo + SQLite + terminal | 2–3 sem | CA-01, CA-03 (PTY), smoke |
| 2 | Agentes: Claude + Codex, eventos, cancelación, capacidades | 3–4 sem | CA-02, CA-11, CA-12 |
| 3 | Git: worktrees, diff, revisión, merge | 2–3 sem | CA-04 |
| 4 | Android: emparejamiento, agentes, aprobaciones | 3–4 sem | CA-05, CA-07 |
| 5 | Acceso a Windows completo (cliente externo → evaluación de embebido) | 2–3 sem (externo) + 4–8 sem (embebido, opcional) | CA-06, (CA-06b) |
| 6 | Coordinador / orquestador | 4–6 sem | Demo end-to-end con repo real |
| 7 | Endurecimiento continuo: backups, retención, diagnóstico, seguridad | continuo (≥ 2 sem inicial) | CA-08…CA-10, checklist release |

**MVP = Etapas 0–5 (cliente externo)** ≈ **13–19 semanas** de calendario realista (mi estimación). Producto completo con coordinador y endurecimiento: **~5–8 meses**.

---

## Etapa 0 · Validación de viabilidad *(prioridad máxima)*

* **Objetivo:** demostrar con hardware real que se puede ver y controlar Windows desde Android, y elegir host remoto.
* **Módulos:** ninguno de producto. Scripts/notas en `poc/` (fuera del producto).
* **Tareas:** PoC-1…PoC-4 (remoto), PoC-5 (node-pty + spawn en Windows), PoC-6 (carga multiagente real), PoC-7 (SQLite crecimiento/backup bajo carga), PoC-8 (se define después: visor embebido). Detalle en `09`.
* **Dependencias:** acceso a la PC Windows y al teléfono Android; cuenta Tailscale; respuestas a las 6 preguntas de `05` §8.
* **Complejidad:** media (por logística, no por código). **Tiempo:** 1–2 semanas.
* **Riesgos:** UAC/bloqueo no capturables; sin monitor físico; latencia alta por VPN; versión de Windows Home.
* **Pruebas / criterios de aceptación:** PoC-1…4 con los umbrales de `09`. Informe con datos.
* **Resultado:** decisión documentada (ADR D-01 y D-02) y semáforo Verde/Ámbar/Rojo para el visor embebido.

## Etapa 1 · Base

* **Objetivo:** Core independiente persistente + UI mínima + terminal real.
* **Módulos:** `contracts`, `domain`, `database`, `services/core` (health, WS, proyectos, PTY manager), `apps/desktop` mínimo (lista de proyectos, terminal), supervisor, tarea programada de inicio.
* **Tareas:** monorepo pnpm + lint/format/typecheck/CI; esquema Drizzle v1 + migraciones; `GET /health`, `WS /events` con `eventId` y reanudación; PTY manager (node-pty) con reconexión; Electron con IPC mínimo seguro; guardado de workspace/layout; logger con redacción.
* **Dependencias:** Etapa 0 (versión de Windows, toolchain). **Complejidad:** media. **Tiempo:** 2–3 sem.
* **Riesgos:** compilación nativa en Windows (node-pty, better-sqlite3); ConPTY y kill del árbol; ciclo de vida del supervisor.
* **Pruebas:** unitarias (Vitest) de dominio y repositorios; integración Core+WS; E2E Playwright (abrir proyecto, restaurar layout); prueba manual: cerrar Electron → terminal sigue viva → reabrir y reconectar (CA-03).
* **Aceptación:** CA-01, CA-03 (PTY), RNF-05; 0 procesos huérfanos tras cerrar (RNF-12).
* **Resultado:** app de escritorio funcional con terminal persistente.

## Etapa 2 · Agentes

* **Objetivo:** ejecutar agentes reales de ≥ 2 proveedores en paralelo con salida en vivo, cancelación y recuperación.
* **Módulos:** `agent-adapters` (claude, codex-exec; esqueleto acp/opencode), scheduler de recursos, reconciler, UI de agentes/permisos, `capabilities`.
* **Tareas:** interfaz `AgentAdapter` + fixtures; adaptador Claude (`claude-cli` sobre el binario oficial con tu suscripción; SDK solo para API key), `canUseTool`/aprobaciones según PoC-9; adaptador Codex (`exec --json`; evaluar `app-server`); OpenCode y Antigravity en una segunda tanda dentro de la etapa si el tiempo lo permite, si no, en la etapa 7; eventos normalizados + NDJSON + índice; cancelación graceful/force con árbol de procesos; reconciliación al arrancar; panel de capacidades; límites de concurrencia; medición de RAM/CPU por run.
* **Dependencias:** Etapa 1; CLIs instalados y autenticación decidida (D-09). **Complejidad:** alta. **Tiempo:** 3–4 sem.
* **Riesgos:** cambios de formato en CLIs; autenticación; `.cmd` en Windows; aprobaciones no uniformes.
* **Pruebas:** contract tests por adaptador con fixtures reales; caos: matar Core durante run (CA-11); 2 agentes de proveedores distintos en paralelo con logs sin mezclar (CA-02); test de que `interactiveApprovals=false` oculta aprobar (CA-12); cancelación sin huérfanos.
* **Aceptación:** CA-02, CA-11, CA-12, CA-08 (parcial).
* **Resultado:** multiagente manual real.

## Etapa 3 · Git

* **Objetivo:** aislamiento, revisión y merge seguros.
* **Módulos:** `git-engine`, UI Diff (Monaco DiffEditor), cola de integración.
* **Tareas:** crear/limpiar worktrees; detección de cambios locales; diff + lista de archivos + riesgos; formato/lint/tests configurables por proyecto; merge secuencial con rama de integración; abort y backup de ref antes de acciones destructivas; limpieza segura; manejo de rutas largas en Windows.
* **Dependencias:** Etapa 2. **Complejidad:** media-alta. **Tiempo:** 2–3 sem.
* **Riesgos:** conflictos semánticos; antivirus bloqueando borrado en Windows; espacio en disco por `node_modules`.
* **Pruebas:** 🧪 base ya probada en Linux (worktrees concurrentes, conflicto, borrado protegido); repetir en Windows; tests de merge con conflictos y rollback; test de limpieza.
* **Aceptación:** CA-04; merge fallido no pierde trabajo.
* **Resultado:** ciclo tarea→worktree→diff→aprobación→merge.

## Etapa 4 · Android

* **Objetivo:** controlar agentes y aprobar permisos desde el teléfono, de forma segura.
* **Módulos:** `security` (pairing, firmas, permisos, auditoría), `apps/mobile` (Expo Dev Build).
* **Tareas:** pairing por QR + aprobación local; firma de peticiones y anti-replay; revocación; pantallas Inicio, Agentes, Permisos, Tareas, Ajustes; reconexión con backoff y `lastEventId`; notificaciones (decidir FCM/ntfy/WS); biometría.
* **Dependencias:** Etapas 2–3 y Tailscale. **Complejidad:** alta. **Tiempo:** 3–4 sem.
* **Riesgos:** ciclo de vida en segundo plano de Android; una sola VPN; cripto mal implementada.
* **Pruebas:** S-01…S-03 de `06`; prueba en red móvil real (otra red); revocar durante sesión; E2E móvil (Maestro).
* **Aceptación:** CA-05, CA-07, RNF-03.
* **Resultado:** panel móvil seguro (sin remoto todavía).

## Etapa 5 · Acceso a Windows completo

* **5a (externo):** integrar "Ver mi PC" con el host elegido en Etapa 0: estado del host en `/remote/status`, lanzar el cliente por intent/deep link, registro de `remote_session`, mensajes de error diferenciados ("PC dormida", "Host no disponible", "Sin sesión autorizada"). **2–3 sem.** Aceptación: CA-06.
* **5b (embebido, opcional, condicionado a la puerta):** módulo nativo (Expo Modules API + Kotlin) sobre `moonlight-common-c`/MediaCodec **o** fork del cliente elegido; control táctil (modo trackpad/táctil), teclado remoto, rotación, multi-monitor. **4–8 sem, incierto.** Se inicia solo si el PoC-8 (spike de 3–5 días) da luz verde y aceptas las implicaciones de licencia (GPL/AGPL: no distribuir).
* **Riesgos:** UAC/bloqueo (RF-08c), consumo de red, mantenimiento de un fork, compilación NDK.
* **Pruebas:** medición de latencia/FPS/ancho de banda (RNF-09); 30 min de uso continuo con Chrome abierto por un agente; reconexión tras cortar red; con y sin monitor físico.
* **Resultado:** control completo de Windows desde Android; opcionalmente integrado.

## Etapa 6 · Coordinador

* **Objetivo:** de una solicitud general a un plan aprobado y ejecutado en paralelo con revisión.
* **Módulos:** `orchestrator` (Plan schema, DAG, scheduler, FSM, política de reintentos), UI del orquestador.
* **Tareas:** run coordinador en modo lectura; validación de plan (ciclos, rutas, solapamiento); aprobación; ejecución con dependencias; revisor automático (tests); tareas de corrección con límite; presupuesto de coste/tiempo; informe final.
* **Dependencias:** Etapas 2–3. **Complejidad:** alta. **Tiempo:** 4–6 sem.
* **Riesgos:** planes erróneos, bucles, coste, conflictos entre tareas.
* **Pruebas:** banco de ≥ 5 repos/objetivos de prueba con resultados esperados; medición de tasa de éxito, coste y tiempo; tests de bucle (máximo de intentos); tests del validador de planes (property-based).
* **Aceptación:** demo end-to-end sin intervención salvo aprobaciones; ninguna modificación fuera del plan.
* **Resultado:** orquestación asistida y auditable.

## Etapa 7 · Endurecimiento (continuo)

* **Tareas:** backups con verificación y prueba de restauración (CA-09); retención de logs/worktrees (CA-10); diagnóstico exportable; métricas; actualización de CLIs con contract tests; auto-actualización probada (con rollback); pruebas de larga duración (72 h, RSS estable); revisión de seguridad externa del pairing.
* **Aceptación:** checklist de release firmado; métricas RNF-10/11/12 dentro de umbral.

---

## Propuesta de MVP (primera versión útil)

**Alcance:** Etapas 0–5a con un adaptador completo (Claude), uno básico (Codex) y "Ver mi PC" con app externa. Sin lienzo, sin voz, sin coordinador, sin visor embebido.
**Por qué:** valida lo que más riesgo tiene (remoto + ciclo de vida del Core + seguridad móvil) antes de invertir en lo demás.

## Primera implementación concreta (tras tu aprobación)

1. **PoC remoto en tus dispositivos reales** (Etapa 0) — no requiere crear el monorepo.
2. Con el resultado, crear monorepo y `packages/contracts` + `services/core` (`/health`, WS, SQLite) + `apps/desktop` mínimo (Etapa 1).

## Pruebas automatizadas por capa

| Capa | Herramienta | Qué cubre |
|---|---|---|
| Dominio / orquestador | Vitest (+ fast-check) | DAG, FSM, validador de plan |
| Adaptadores | Vitest + fixtures por versión | Contrato de eventos |
| Core | Vitest + servidor de prueba | API, WS, reanudación, reconciliación |
| BD | Vitest + SQLite temporal | Migraciones hacia delante, backup/restore, retención |
| Git | Vitest + repos temporales | Worktrees, merge, limpieza |
| Electron | Playwright (Electron) | Flujos de UI, aislamiento |
| Android | Maestro/Detox (opcional) | Pairing, aprobaciones |
| Caos | Scripts (matar Core/agente/red) | Recuperación |
| Larga duración | Soak 72 h | RAM, handles, disco |
| Seguridad | `06` §9 | Checklist S-01…S-10 |
