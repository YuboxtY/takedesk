# 05 · Requerimientos

> Fecha: 2026-10-18. Base: documento original (RF-01…RF-12, CA-01…CA-10) + correcciones de `01` §3.
> Estado = clasificación de viabilidad (Confirmada / Probable / Experimental / No viable) **hoy**, no estado de implementación (todo está sin implementar).
> Etapa = etapa de `07-PLAN-DE-DESARROLLO.md` donde se entrega.

## 1. Requerimientos funcionales

| ID | Requerimiento (refinado) | Prio | Estado | Etapa | Cambio vs original |
|---|---|---|---|---|---|
| RF-01 | Agregar, abrir, buscar y recordar proyectos Git locales | P0 | Confirmada | 1 | |
| RF-02 | Paneles: editor (Monaco), terminal (xterm), vista localhost aislada, diffs, agentes; layout persistido y restaurable si falta un monitor | P0 | Confirmada | 1–3 | Aísla webview (C-13) |
| RF-03 | Lanzar/detener agentes con salida en tiempo real | P0 | Confirmada | 2 | |
| RF-04 | Ejecutar agentes concurrentes con presupuesto por recursos y por proveedor | P0 | Probable | 2 | Límite por recursos (no número fijo) |
| RF-05 | Un worktree exclusivo por agente escritor | P0 | Confirmada 🧪 | 3 | |
| RF-06 | Diff, formato/lint/tests y aprobación explícita antes de integrar; merge secuencial | P0 | Confirmada | 3 | |
| RF-07 | Android conectado por red privada autorizada y emparejamiento propio | P0 | Probable | 4 | Pairing obligatorio |
| RF-08a | **Ver y controlar la pantalla completa de Windows desde Android mediante cliente remoto externo** lanzado desde la app | P0 | Probable | 0 → 5 | Separa de 08b |
| RF-08b | Visor remoto **embebido** en la app Android | P1 | Experimental | 5b | Antes mezclado con RF-08 |
| RF-08c | Operar UAC / pantalla de bloqueo / inicio de sesión | P1 | Experimental | 5 | Nuevo |
| RF-09 | Gestionar tareas/agentes y aprobar permisos desde Android | P1 | Confirmada | 4 | |
| RF-10 | Reanudar sesiones cuando el adaptador lo declare; indicar no reanudables | P1 | Probable | 2 | |
| RF-11 | Orquestación automática con plan aprobado, dependencias y revisión | P2 | Probable | 6 | |
| RF-12a | Notificaciones push (permisos, fin de run) | P2 | Probable | 4–7 | |
| RF-12b | Multi-monitor en remoto | P2 | Probable | 5 | |
| RF-12c | Voz | P2 | Experimental | post | |
| RF-13 | **Nuevo:** Panel de capacidades por proveedor (qué soporta cada adaptador) | P1 | Confirmada | 2 | C-04 |
| RF-14 | **Nuevo:** Gestión de dispositivos (listar, permisos, revocar) | P0 | Confirmada | 4 | |
| RF-15 | **Nuevo:** Registro de auditoría consultable | P1 | Confirmada | 4 | |
| RF-16 | **Nuevo:** Respaldo/restauración y diagnóstico exportable | P1 | Confirmada | 7 | |
| RF-17 | **Nuevo:** Control de costes/tokens por run cuando el proveedor lo informe | P2 | Probable | 6 | |

## 2. Requerimientos no funcionales (medibles)

| ID | Categoría | Requisito | Métrica / umbral inicial (a validar) |
|---|---|---|---|
| RNF-01 | Seguridad | Toda petición móvil autenticada y firmada | 100 % de rutas salvo `/health` mínimo |
| RNF-02 | Seguridad | Sin puertos públicos | Escaneo externo: 0 puertos abiertos del Core/host |
| RNF-03 | Seguridad | Revocación efectiva | Cierre de WS y sesiones < 2 s tras revocar |
| RNF-04 | Integridad | Backup verificable | `integrity_check` ok y restauración probada cada semana |
| RNF-05 | Resiliencia | Cierre de Electron no afecta runs | CA-03 |
| RNF-06 | Resiliencia | Tras caída de Core no hay `completed` sin evidencia | CA-08 |
| RNF-07 | Rendimiento | Latencia de eventos Core→UI | p95 < 200 ms en LAN, < 500 ms por VPN |
| RNF-08 | Rendimiento | UI con 10 runs activos | 60 fps en scroll de terminal; sin congelar > 100 ms |
| RNF-09 | Rendimiento remoto | Latencia entrada→imagen | Objetivo p95 < 150 ms (VPN/WAN) — a medir en PoC |
| RNF-10 | Datos | Crecimiento acotado | BD < 1 GB a 3 años con retención por defecto (objetivo) |
| RNF-11 | Memoria | Sin fugas | RSS del Core estable ±10 % tras 72 h de carga sintética |
| RNF-12 | Procesos | Sin huérfanos | 0 procesos hijos tras cancelar/cerrar (prueba automática en Windows) |
| RNF-13 | Usabilidad | Móvil usable con una mano en vertical (panel) y horizontal (remoto) | Pruebas con usuario |
| RNF-14 | Accesibilidad | Contraste AA, texto escalable, estados no solo por color | Auditoría |
| RNF-15 | Observabilidad | Diagnóstico sin secretos | Test de redacción con secretos plantados |
| RNF-16 | Mantenibilidad | Límites de módulos | Verificados en CI |
| RNF-17 | Compatibilidad | Cliente↔servidor | Negociación `minClient`; N-1 soportado |

## 3. Criterios de aceptación del MVP (CA del original, con precisiones)

| CA | Criterio | Cambio |
|---|---|---|
| CA-01 | Windows abre un proyecto Git y restaura el workspace tras reiniciar | |
| CA-02 | **Dos agentes de proveedores distintos** corren en paralelo en worktrees separados; UI correcta; logs sin mezclar | + proveedores distintos |
| CA-03 | Cerrar Electron no termina sesiones ni PTYs | + PTYs (C-01) |
| CA-04 | Diff visto y aprobado antes de integrar; merge fallido no pierde trabajo | |
| CA-05 | Android conecta desde otra red por acceso privado sin API pública (verificado por escaneo) | + verificación |
| CA-06 | "Ver mi PC" muestra Chrome abierto **por un agente** fuera de Electron y permite clic, escritura y navegación | + lanzado por agente |
| CA-06b | Con la PC bloqueada: se puede ver/desbloquear (si se cumple RF-08c) o se muestra mensaje correcto | nuevo; condicional al PoC |
| CA-07 | Dispositivo revocado no ejecuta comandos ni inicia sesiones (incluida sesión remota abierta) | |
| CA-08 | Tras reinicio inesperado no hay runs `completed` con resultado desconocido | |
| CA-09 | Backup y restauración de SQLite completados y verificados | |
| CA-10 | Logs con retención y sin secretos (test con secretos plantados) | |
| CA-11 | **Nuevo:** matar el Core a mitad de un run deja el estado `pending_reconciliation`→ correcto, sin procesos huérfanos | |
| CA-12 | **Nuevo:** un adaptador con `interactiveApprovals=false` nunca muestra botón de aprobar | |

Ningún CA se considera cumplido porque "compile": cada uno tiene prueba automatizada o procedimiento manual registrado (`07`, `09`).

## 4. Interfaz Windows (pantallas)

| Pantalla | Contenido | Estado de la idea |
|---|---|---|
| Inicio | Proyectos recientes, estado del Core, dispositivos conectados, alertas | Mockup (no implementado) |
| Proyectos | Alta/búsqueda, estado Git | |
| Lienzo / Workspace | Paneles redimensionables; lienzo React Flow (post-MVP) | |
| Terminales | Pestañas xterm conectadas a PTYs del Core | |
| Editor | Monaco + DiffEditor | |
| Navegador | Vista localhost aislada (sin Node, sin preload) | |
| Agentes | Tarjetas con estado, proveedor, capacidades, coste | |
| Conversaciones | Hilos por run | |
| Tareas | Lista/Kanban con dependencias | |
| Orquestador | Plan propuesto, aprobar/editar, progreso del DAG | |
| Git / Diff Viewer | Ramas, worktrees, diffs, tests | |
| Historial | Runs, aprobaciones, auditoría | |
| Configuración | Perfiles de agente, límites, retención, backups, seguridad | |
| Acceso remoto | Dispositivos, estado del host remoto, sesiones, revocar | |

## 5. Interfaz Android (pantallas)

| Pantalla | Contenido |
|---|---|
| Inicio | Estado de la PC (en línea/dormida/host remoto), runs activos, alertas, botón **Ver mi PC** |
| Conexión | Emparejar por QR, huella del Core, reconexión |
| Estado del equipo | CPU/RAM/disco, procesos de agentes |
| PC (remoto) | Visor horizontal inmersivo; barra: clic, clic derecho, teclado, zoom, monitor, desconectar |
| Agentes | Tarjetas; detalle con salida en vivo |
| Conversaciones | Hilos con adjuntos |
| Terminales | Solo lectura por defecto; escritura con confirmación |
| Proyectos / Tareas | Progreso, dependencias, diffs ligeros |
| Permisos | Cola de aprobaciones con contexto (comando, ruta, riesgo) |
| Notificaciones | Reglas por tipo |
| Ajustes y seguridad | Dispositivos, bloqueo de la app (biometría), cerrar sesiones |

Reglas: sin mostrar claves ni secretos; acciones destructivas con confirmación explícita y, si es sensible, autenticación reciente (biometría).

## 6. API (extensión del documento)

| Ruta | Uso | Permiso |
|---|---|---|
| `GET /v1/health` | versión, `minClient`, estado | mínimo, sin datos sensibles |
| `POST /v1/pairing` | iniciar emparejamiento (solo local) | local |
| `POST /v1/pairing/complete` | completar con code + pubkey | code válido |
| `GET /v1/devices`, `DELETE /v1/devices/:id` | gestión | `devices.manage` |
| `GET /v1/projects` | listar | `projects.read` |
| `POST /v1/tasks`, `POST /v1/plans`, `POST /v1/plans/:id/approve` | tareas/plan | `tasks.manage` |
| `POST /v1/runs`, `POST /v1/runs/:id/cancel` | ejecutar/cancelar | `runs.execute` (cancel: confirmación) |
| `POST /v1/approvals/:id` | decidir | `approvals.decide` + auth reciente |
| `GET /v1/runs/:id/events?since=` | eventos paginados | por proyecto |
| `GET /v1/capabilities` | capacidades por adaptador | `projects.read` |
| `GET /v1/remote/status`, `POST /v1/remote/session` | estado del host y sesión | `remote.view` / `remote.control` |
| `GET /v1/diagnostics/export` | diagnóstico sin secretos | `admin` (local) |
| `WS /v1/events` | eventos incrementales | token corto + límite de mensajes |

Eventos: `agent.run.created`, `agent.output.delta`, `agent.approval.requested`, `agent.run.finished`, `test.finished`, `git.diff.ready`, `remote.host.unavailable`, + `plan.proposed`, `device.revoked`, `system.degraded`. Todos con `eventId`, `ts`, `scope`, `v`.

## 7. Dependencias externas de requisitos
RF-08*: PoC (`09`). RF-03/RF-10: versiones de CLIs y su autenticación autorizada por cada proveedor (decisión del usuario: ¿qué CLIs hay instalados y con qué cuenta?). RF-07: cuenta Tailscale (u otra red privada).

## 8. Decisiones abiertas del documento original (estado tras tu respuesta del 2026-10-18)

| # | Pregunta | Estado |
|---|---|---|
| 1 | Windows y Android | **Respondida.** PC: ASUS ROG Strix G531GT, **Windows 11 Home**, **con permisos de administrador** (permite instalar el host remoto como servicio). Móvil: **Samsung Galaxy S25 Ultra, One UI 9** (versión de Android asociada sin verificar). |
| 2 | Primera entrega: ¿cliente externo o visor embebido? | **Respondida: cliente externo** (D-02 aceptada) |
| 3 | CLIs instalados y autenticación | **Respondida:** Claude Code, Codex, OpenCode y Antigravity, **todos con suscripción** (salvo aclarar qué proveedor usa OpenCode). Consecuencias en D-09 y D-16 |
| 4 | Hardware y nº máximo de agentes | **Respondida:** i7-9750H (6 núcleos/12 hilos), **16 GB RAM**, GTX 1650 4 GB + Intel UHD 630, SSD 477 GB con **solo ~63 GB libres**. Ver `08` §6. Límite inicial propuesto: **3 agentes simultáneos** (a validar con PoC-6) |
| 5 | Política de comandos riesgosos | Propuesta vigente: preguntar siempre |
| 6 | Solo uso personal | **Respondida: sí, por ahora.** Mantiene viable usar/forkear software AGPL/GPL sin distribuirlo; si cambia, ver `08` §3 |
