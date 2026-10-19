# 09 · Pruebas de concepto

> Fecha: 2026-10-18.
> **Parte A** = pruebas que **sí ejecuté** en este entorno (Linux, sin Windows/Android). **Parte B** = pruebas que **debes ejecutar tú** en tus dispositivos reales con criterios de aceptación definidos; **están sin ejecutar** y por tanto *ningún* resultado de la Parte B está asumido.

---

## A. Pruebas ejecutadas (🧪)

Entorno: Linux 6.18, Node v22.22.0, npm 10.9.4, git 2.43.0, Python 3 (SQLite del módulo estándar).

### A-1 · Git worktrees concurrentes y conflicto
**Qué comprueba:** aislamiento por worktree (RF-05) y reglas 8.11–8.18 del documento.
**Procedimiento:** repo con un commit; 3 worktrees (`task/t1..t3`); 3 procesos en paralelo escriben y hacen commit en su worktree; luego merge de `t1` y `t2` (ambos modifican la misma línea); y borrado de un worktree con cambios sin confirmar.
**Resultado observado:**
* Los 3 commits concurrentes terminaron sin interferirse; `git worktree list` mostró 4 entradas.
* `git merge task/t2` tras `t1` → `CONFLICT (content)`; estado `UU f.txt`; `git merge --abort` limpió.
* `git worktree remove` sobre worktree sucio → `fatal: contains modified or untracked files, use --force`.
**Conclusión:** respalda la estrategia. **No prueba:** Windows (rutas largas, antivirus, bloqueo de archivos), repos grandes, `node_modules` por worktree.

### A-2 · SQLite WAL con escritores concurrentes + backup con API oficial
**Procedimiento:** BD en `journal_mode=WAL`; 4 hilos insertan 5 000 filas cada uno (20 000 en total); durante las escrituras se ejecuta `sqlite3.Connection.backup()` a un archivo nuevo; se verifica `PRAGMA integrity_check`.
**Resultado:** `backup integrity: ok`, 20 000 filas en la copia; WAL final ≈ 6 MB; escrituras en 0,22 s.
**Limitación honesta:** las escrituras acabaron tan rápido (0,22 s) que el backup apenas se solapó con ellas; **es evidencia débil de consistencia bajo carga**. La prueba real (PoC-7) debe usar escritura sostenida de minutos con `better-sqlite3`.

### A-3 · node-pty: spawn, salida y kill
**Procedimiento:** `npm install node-pty`; `pty.spawn('bash', ['-c','echo hola; sleep 30'])`; leer `onData`; `kill()` a los 500 ms.
**Resultado:** salida `"hola"`; `onExit` con `{"exitCode":0,"signal":1}`; la instalación compiló/instaló sin errores.
**Conclusión:** node-pty funciona en Node 22 **en Linux**. **No prueba ConPTY/Windows** (PoC-5), ni el kill del árbol de procesos.

### A-4 · Validación sintáctica de los diagramas
Los 15 diagramas de `04-DIAGRAMAS.md` se renderizaron a SVG con `@mermaid-js/mermaid-cli` sin errores. Valida sintaxis, **no** la corrección arquitectónica.

### A-5 · Verificación de licencias y documentación
Leí directamente los archivos de licencia/documentación citados en `01` §8 (marcados ✅). Varios dominios no resolvían desde el entorno (`learn.microsoft.com`, `developers.openai.com`, `opencode.ai`, `geminicli.com`), por lo que esas afirmaciones quedan 🔎/🧠.

### A-6 · Código de la Etapa 1–3 (2026-10-19)
`pnpm verify` en Linux: **límites de módulos OK (40 imports) · tipos OK · 95 pruebas en 10 archivos**. Cubre: contratos, máquina de estados, redacción, plataforma, BD (migraciones, corrupción detectada, backup con escritura sostenida, retención), log NDJSON, git-engine, adaptadores de procesos (reenganche, cancelación del árbol, agente muerto), RunManager (límites, recursos, cuota, aprobaciones, cancelación, reconciliación con procesos reales), API/WebSocket/terminales y supervisor.
**Prueba de mutación** (se rompe el código a propósito y se comprueba que las pruebas fallan): 6 de 6 detectadas — stream cortado declarado *completed*; wrapper muerto declarado éxito; auth desactivada; merge con conflicto sin abortar; límite por proveedor ignorado; worktree sucio borrado sin avisar.
**Humo del proceso real:** el Core arranca como proceso independiente, `/health` público mínimo, 401 sin token, 421 con `Host` falso, run completo con worktree, SIGTERM → código 0, el token no aparece en el log, y reinicia sobre la misma BD.
**Límites:** solo Linux; adaptadores simulados y un agente de prueba (no CLIs reales); sin Windows, Electron ni Android; carga y duración (soak) sin medir.

---

## B. Pruebas a ejecutar por el usuario (sin ejecutar)

Preparación común: Windows en el equipo definitivo; teléfono Android real; cuenta Tailscale en ambos; anota versión de Windows (edición), de Android, hardware y red (WiFi/4G/5G). Para cada prueba registra: fecha, versión del software, resultado, capturas y medidas.

### PoC-1 · Ver y controlar Windows completo desde Android (decisivo)
**Candidatos:** (1) RustDesk autoalojado (hbbs/hbbr) accesible solo por Tailscale; (2) Sunshine + Moonlight. Instalación del host **como servicio**.
**Escenario:** abrir Chrome (modo headed) **lanzado desde una terminal/agente**, VS Code, Explorador de archivos y una ventana de pruebas; desde Android (fuera de la LAN, por datos móviles) ver, hacer clic, escribir, abrir una URL.
**Aceptación (CA-06):** se ve Chrome abierto fuera de Electron; clic, escritura y navegación funcionan; 30 min continuos sin desconexión; teclado en pantalla usable (texto, atajos, Tab/Esc, Ctrl+C).
**Medir:** latencia percibida y medida (cámara/slow-mo o marcador de tiempo), FPS, ancho de banda por minuto (calidad baja/alta), CPU/GPU del host.

### PoC-2 · Comparativa RustDesk vs Sunshine+Moonlight
Tabla a rellenar: instalación (min), latencia p50/p95, FPS, MB/min, calidad de texto, modos de entrada táctil (trackpad vs táctil directo), teclado remoto, portapapeles, multi-monitor, reconexión tras cortar red (tiempo), consumo de batería del móvil, facilidad de lanzar desde otra app (intent/deep link), opciones de seguridad (desactivar relays públicos, contraseña fija, aprobación).
**Decisión (ADR D-01):** obligatorios = consola real + entrada usable; luego ponderar latencia, UAC/bloqueo, seguridad, integrabilidad, licencias.

### PoC-3 · Escritorios seguros y sin monitor
Con cada candidato:
1. Aparece un **UAC** (p. ej. ejecutar un instalador como administrador): ¿se ve? ¿se puede aceptar desde Android?
2. **Win+L** (bloqueada): ¿se ve la pantalla de bloqueo? ¿se puede introducir PIN/contraseña? (decide si lo quieres permitir; ver `06` §7).
3. **Cerrar sesión** y pantalla de inicio de sesión.
4. **Sin monitor físico** (desconectar o usar *dummy plug*): ¿sigue habiendo imagen? ¿resolución?
5. Ventana elevada (Administrador de tareas): ¿responde el ratón?
**Aceptación:** documentar cada caso como OK / parcial / no. Define RF-08c (Experimental → Probable o rechazado).

### PoC-4 · Multi-monitor, rotación y reconexión
Cambiar de monitor, rotar a horizontal, modo inmersivo, cortar WiFi→4G y recuperar sesión. Aceptación: reconexión automática < 10 s o mensaje claro.

### PoC-5 · Terminal y procesos en Windows
En Windows: instalar toolchain (Node LTS, pnpm, Git, Python, VS Build Tools con C++ y librerías Spectre); `npm i node-pty`; abrir PowerShell vía ConPTY; ejecutar `claude`/`codex`/`gemini` en PTY; comprobar:
* Compila y funciona sin `@electron/rebuild` (Core es Node puro).
* Cierre: matar el árbol (PowerShell + hijos) con Job Object / `taskkill /T` → **0 procesos huérfanos** (RNF-12).
* Error `8009001d` de PowerShell con entorno recortado (✅ README) → confirmar que pasamos `SystemRoot`.
* `spawn` de CLIs instalados con npm (`.cmd`): ¿falla sin shell? ¿cómo se resuelve el ejecutable real?
* ¿Claude Code y compañía requieren Git for Windows / shell concretos? (anotar).
* Rutas largas y antivirus con worktrees.

### PoC-6 · Concurrencia real de agentes
Con tu hardware y CLIs: lanzar 1, 2, 4, 6, 8 agentes (mezcla de proveedores) sobre repos pequeños con tarea fija; medir RAM total y por proceso, CPU, tiempos, errores 429/limites, estabilidad 30 min. Salida: **tabla real** que sustituya mis supuestos y fije los umbrales del scheduler. Incluir Chrome headed y el host remoto activos.

### PoC-7 · SQLite: crecimiento, backup y restauración bajo carga
Con `better-sqlite3` + Drizzle: simular 365 días de eventos (p. ej. 20 runs/día × 5 000 eventos) con retención activa; medir tamaño de BD, tiempo de consultas paginadas, tiempo de `VACUUM INTO`; hacer backup **durante** escritura sostenida de varios minutos; restaurar en directorio temporal y comprobar `integrity_check` y apertura de proyectos. Aceptación: CA-09 y objetivo RNF-10.

### PoC-8 · Spike del visor embebido *(solo si PoC-1/2 son favorables)*
3–5 días: (a) módulo Expo (Kotlin) que renderice un stream Moonlight en `SurfaceView` dentro de la app RN; **o** (b) evaluar fork del cliente Flutter de RustDesk con pantallas de agentes. Criterio: ver un stream y enviar un clic desde dentro de nuestra app compilada con Dev Build. Salida: semáforo y estimación revisada para Etapa 5b.

### PoC-9 · Adaptadores de agentes (mínimo viable)
Script Node: lanzar Claude (SDK) y Codex (`exec --json`) en worktrees distintos (después OpenCode con `opencode serve` y Antigravity con `agy` en stream-json, que son los CLIs que tienes instalados) con la misma tarea; normalizar eventos; cancelar a mitad; matar el proceso padre y comprobar reconciliación. Aceptación: CA-02, CA-11. Verificar con **tu suscripción** (sin API key): `claude -p --output-format stream-json` con entrada `stream-json`, flujo de aprobaciones (`--permission-prompt-tool`), eventos de límite de uso y `--resume`; `codex exec --json` con inicio de sesión de ChatGPT; `agy` headless con aprobaciones; OpenCode con el proveedor que uses. Anotar cómo se manifiesta cada límite de cuota. Anotar qué campos reales emite cada versión (sustituye mis suposiciones 🔎).

### PoC-10 · Red privada y exposición
Android en datos móviles → Core por Tailscale; escaneo externo de la IP pública del hogar: ningún puerto abierto (CA-05, RNF-02). Medir latencia API y reconexión de WS.

---

### Añadido: pruebas específicas del equipo del usuario (portátil ROG G531GT + S25 Ultra)
* **PoC-3b · Portátil:** con tapa cerrada y acción "No hacer nada": ¿sigue la captura y el control? ¿Y con la pantalla interna apagada? Probar con el cargador conectado y con batería. Registrar el plan de energía y cuánto tarda en suspender.
* **PoC-2b · GPU híbrida:** Sunshine con NVENC (GTX 1650), con Quick Sync (UHD 630) y con codificación por software; RustDesk con códecs disponibles. Anotar FPS, latencia, uso de CPU/GPU, temperatura y si aparece pantalla negra por selección de GPU.
* **PoC-2c · S25 Ultra:** decodificación por hardware en cada cliente; consumo de batería en 30 min; comportamiento con la optimización de batería de Samsung activada/desactivada.
* **PoC-6b · Disco:** medir el tamaño real de un worktree de tus proyectos (con y sin dependencias, con pnpm) y el espacio libre tras 5 worktrees; validar la cuota de 15 GB. Con ~63 GB libres, esto puede decidir cuántos agentes escritores caben a la vez.

## C. Cómo se registrarán los resultados
Plantilla por prueba en este archivo (sección D, a añadir): `ID · fecha · entorno · versión del software · procedimiento · datos medidos · veredicto (Cumple / Parcial / No cumple) · notas`. Un PoC "Cumple" solo con datos medidos y evidencia (capturas/logs), nunca por "se ve bien".

## D. Resultados de la Parte B
### PoC-5 · 2026-10-19 · Windows 11 Home build 26200 · Node 26.5.1 · pnpm 10.0.0 · Git 2.55.0
Procedimiento: docs/11 parte B. Datos: `poc-report.md`. Veredicto: **Parcial** (12/15 OK; `test:win` 38/38; boundaries y typecheck OK). `Get-ComputerInfo` rotula la edición como "Windows 10 Home" aunque el build 26200 es Windows 11.
* `pnpm install` compiló better-sqlite3 con VS Build Tools 2022 sin incidencias; node-pty OK (ConPTY real con PowerShell).
* Node 26 ya no trae corepack: hubo que `npm i -g corepack` antes de `corepack prepare pnpm@10.0.0 --activate`.
* **Test ajustado (artefacto de Windows):** con `core.autocrlf=true` (Git for Windows) el merge deja `f.txt` en CRLF; el test de git-engine normaliza saltos de línea. El motor no cambia.
* **Sonda de versión de shims `.cmd`:** en `poc-env.ts` el quoting de `execFile` rompía `cmd /c`; ahora usa `windowsVerbatimArguments`. opencode 1.18.25 y pnpm 10.0.0 se detectan como shims `.cmd` y se ejecutan vía cmd.exe.
* **FALLA · rutas largas (>260):** `git worktree add` aborta con `fatal: '$GIT_DIR' too big` aunque se pase `core.longpaths=true`; Node sí crea esas rutas. Límite de Git for Windows (`LongPathsEnabled` está en 0 y no se tocó, es ajuste de sistema). **Mitigación pendiente de diseño:** raíz de worktrees corta (p. ej. `C:\aiw\wt`) y validar longitud de ruta antes de crear.
* **FALLA · `codex` y `agy` no están en PATH** en esta PC (claude y opencode sí). No es fallo de código: instalarlos o indicar su ruta.
* node-pty: al matar el shell aparece `Error: AttachConsole failed` (conpty_console_list_agent) y salida -1073741510 (0xC000013A); carrera conocida de node-pty al cerrar un ConPTY. El eco y el cierre pasan y no quedan huérfanos.
* killTree mató hijo y nieto sin restos; SQLite WAL + backup + integrity_check OK; agente desacoplado: reenganche y cancelación OK.

### PoC-9 (parcial) · 2026-10-19 · Adaptador Claude Code 2.1.220 en Windows
* Implementado `createClaudeAdapter` (`packages/agent-adapters/src/claude-adapter.ts`): `claude -p <prompt> --output-format stream-json --verbose --permission-mode plan|acceptEdits` (read→plan, write→acceptEdits; nunca se salta permisos). Capacidades: sin aprobaciones interactivas todavía (`interactiveApprovals=false`), `resume=native`.
* **Verificado con salida real:** el evento de sesión (`system/init`), el error de autenticación (`assistant` con `error: authentication_failed` + `result.is_error`) se capturaron de la CLI real. **No verificado:** texto, herramientas y `rate_limit_event` con una sesión autenticada: en el subproceso la CLI respondió "Not logged in" (la sesión de la app de escritorio no se comparte). Para cerrarlo: ejecutar `claude /login` en una terminal y repetir con un prompt real.
* **Hallazgo Windows corregido:** `killTree(graceful)` usaba `taskkill /T` sin `/F`, que no cierra procesos de consola sin ventana: el árbol seguía vivo. Ahora escala a `/F` tras 3 s (`graceMs`).
* Los tests de `platform` marcados "POSIX real" (killTree con `setsid`, `resolveExecutable` esperando `node$`) fallan en Windows por diseño; no forman parte de `test:win`.

### PoC-9 (parcial) · 2026-10-19 · Adaptador OpenCode 1.18.25 en Windows — **Cumple (verificado con ejecución real)**
* `createOpenCodeAdapter`: `opencode run --format json --dir <cwd> [--agent plan] <prompt>`; nunca `--auto`. Los modelos gratuitos por defecto usan `dataPolicy: 'may-train'`.
* Formato real observado: `step_start` (con `sessionID`), `text`, `tool_use` (llega ya con estado final `completed`), `step_finish` (tokens) y `error` (el proceso sale con código 0 aun así, por eso el adaptador convierte `error` en `run.finished ok:false`).
* Prueba de extremo a extremo (`services/core/scripts/e2e-opencode.ts`): sesión → `read` → texto final → `run.finished ok`, lanzando por el shim `opencode.cmd`.
* **Hallazgo Windows corregido:** Node no puede lanzar un `.cmd` sin shell (EINVAL) y pasar el prompt por `cmd.exe` permite inyección. Nuevo `unwrapShim` en `platform` resuelve el `.exe` real del shim npm; el adaptador lo usa y falla con claridad si no lo reconoce.
* El Core ahora registra los adaptadores `claude` y `opencode` por defecto (el simulado solo con `AIW_ENABLE_FAKE=1`).
* `services/core/test/server.test.ts` (terminales) sigue fallando en Windows porque los helpers fijan `bash` como shell; no forma parte de `test:win`.

### Etapa 1 · App de escritorio Electron mínima (`apps/desktop`) · 2026-10-19 · Electron 39.8.10 en Windows 11
* Ejecutar: `pnpm desktop`. La app lanza el Core como **proceso desacoplado con el Node del sistema** (better-sqlite3/node-pty están compilados para ese Node, no para el de Electron) o reutiliza uno ya sano en `127.0.0.1:47821`. **Verificado:** al cerrar Electron el Core sigue respondiendo (CA-03, lado cliente).
* Seguridad: `contextIsolation`, `sandbox`, sin `nodeIntegration`, CSP `default-src 'none'`, navegación y ventanas nuevas bloqueadas. El renderer **nunca ve el token**: pide al proceso principal (`api-proxy.cjs`), que añade `Authorization` y solo admite una lista blanca de rutas `/v1` (GET/POST). La interfaz inserta datos con `textContent` (prompts y salidas son contenido no confiable).
* UI: estado del Core, proyectos (selector de carpeta nativo), lanzar run (agente, modo, aceptación de política `may-train`), lista de runs con cancelar y salida en vivo por sondeo de `/events`. Sin terminal, diff ni aprobaciones aún.
* Registro del Core en `core.log` dentro de `%LOCALAPPDATA%\AIWorkspace`. El módulo `desktop` se añadió a `check:boundaries` sin dependencias internas (solo HTTP).
* **Incidencia de instalación (Node 26):** el postinstall de Electron termina en silencio al extraer el zip (extract-zip). Se extrajo manualmente el zip oficial (sha256 verificado contra `checksums.json`) a `node_modules/.pnpm/electron@39.8.10/.../electron/dist` y se creó `path.txt`. En una instalación limpia habrá que repetirlo, o usar Node LTS (22/24) para `pnpm install`.
* **No verificado:** aspecto visual y flujo completo de un run desde la interfaz (la ventana se abrió y las llamadas autenticadas al Core respondieron 200, pero no se probó interactuando).

### Etapa 1 · cierre de pendientes de Electron · 2026-10-19
* **Terminal integrada** (xterm.js 5 + `terminal-bridge.cjs`): el WebSocket y el ticket viven en el proceso principal; el renderer solo usa IPC. Cerrar la app solo suelta los sockets; los terminales siguen en el Core.
* **Workspace** (`workspace.json` en userData): se restauran proyecto, agente, modo, run y terminal seleccionados.
* **E2E real** (`node apps/desktop/scripts/e2e.mjs`, Electron + CDP con datos y puertos aislados): **11/11 OK** — ventana y Core, proyecto vía proxy, terminal ConPTY con eco visible en xterm, el renderer no ve el token y recibe 403 fuera de la lista blanca, cierre normal de la ventana, **CA-03** (Core y terminal siguen vivos) y, al reabrir, workspace restaurado y **scrollback recuperado**.
* **Tests del Core en Windows:** los helpers ahora usan PowerShell en win32 (antes fijaban `bash`); `services/core` 39/39 y `test:win` ampliado a desktop, core y agent-adapters (107 tests).
* **Tarea programada de inicio:** `scripts/install-startup.ps1` (y `-Remove`), sin admin, solo 127.0.0.1. Sintaxis validada pero **NO ejecutada** ni probada en un reinicio: modifica la configuración del sistema, así que la activas tú.
* Nota de prueba: `taskkill /T` sobre Electron también mata al Core (descendiente por PID); un cierre normal de ventana no. El E2E cierra la ventana como el usuario.
* **Pendiente de Etapa 1:** Playwright/CI formal, prueba tras reinicio de la tarea programada, ACL del `api-token` (icacls), RNF-12 (0 huérfanos tras cerrar) medido en sesión larga, aspecto visual revisado por una persona.

### Etapa 3 · Revisión de diff y fusión con aprobación (CA-04) · 2026-10-19
* **Core:** `MergeService` + `GET /v1/runs/:id/diff` y `POST /v1/runs/:id/merge {approvedHead}`. `review` guarda el trabajo del agente en un commit y devuelve archivos, stat y parche junto con `reviewedHead`; `merge` **exige ese commit exacto** (si el worktree cambió o el hash no coincide → 409 `diff-changed`), serializa fusiones por proyecto y registra auditoría (`merge.approved` / `merge.conflict`) y el evento `worktree.merged`. Solo para runs de escritura **completados**.
* **Sin pérdidas:** un conflicto aborta la fusión (409 `merge-conflict` con los archivos), la rama principal queda intacta, el repo sin fusión a medias y el trabajo del agente a salvo en su rama/worktree. Si el repo del proyecto tiene cambios locales no se fusiona (`targetDirty` se avisa en la revisión). Tras fusionar se limpia el worktree y se borra la rama.
* **App:** botón "Revisar cambios" en runs de escritura completados, diff coloreado (insertado con `textContent`), "Aprobar y fusionar", mensajes de conflicto y marca "fusionado". El proxy admite solo `diff` y `merge` como rutas nuevas.
* **Verificación:** 6 pruebas nuevas de `MergeService` (Core 45/45) y E2E real en Electron **18/18** (añade: botón, diff visible, fusión a la rama principal, worktree limpiado, segundo run en conflicto con mensaje en la UI, main intacto y trabajo a salvo). Suite `test:win` verde.
* **Límites:** el "agente" del E2E es el adaptador simulado más un archivo escrito en su worktree (no un LLM real). No hay resolución de conflictos asistida, ni fusión de runs `failed`/`cancelled`, ni aprobación desde móvil (Etapa 4). En el E2E se fijan `AIW_RESERVE_MEM_GB=0` y `AIW_MIN_FREE_DISK_GB=0`: con poca RAM libre los runs se quedan en cola (la protección funciona, pero conviene mostrar el motivo en la UI).
* **Corrección de lo anterior (honestidad de la verificación):** la primera ejecución completa de `test:win` justo después del E2E falló 3 pruebas dependientes de tiempo (terminales, reenganche CA-11 en Core y en adapters) mientras aún se cerraban procesos del E2E; repetida 2 veces seguidas pasó 113/113, y Core + adapters aislados 66/66. Se considera **flakiness bajo carga**, no corregida: esas pruebas usan esperas fijas y deberían volverse más tolerantes (pendiente).

### Etapa 1/5 · Lienzo de paneles estilo Deska (cada modelo en su pestaña) · 2026-10-19
* **Decisión de producto (del usuario):** el resultado final NO es juntar los modelos en una sola terminal; es un **lienzo con muchos paneles independientes** (como Deska). Se rehízo la interfaz de `apps/desktop` en consecuencia.
* **Lienzo** (`tiles.js`): paneles que se arrastran por la cabecera, se redimensionan por la esquina (cuadrícula de 10 px), se enfocan al tocarlos, se cierran con ×, y se colocan solos en el primer hueco libre sin solaparse. Layout (posición, tamaño, z-order y estado de cada panel) persistente en `workspace.json`, saneado en el proceso principal (`workspace.cjs`: tipos conocidos, ≤ 40 paneles, límites de tamaño y de texto).
* **Tipos de panel** (`panes.js`): **Terminal** (xterm + addon-fit, una sesión del Core por panel), **Agente** (uno por modelo/adaptador: su propio run, salida en vivo, modo lectura/escritura, cancelar, política `may-train`, "Revisar cambios"), **Revisión** (diff coloreado y "Aprobar y fusionar", ligado al commit revisado) y **Notas**. La barra permite abrir tantos como se quiera, incluidas **sesiones interactivas de cada CLI** (`Claude Code (CLI)`, `OpenCode (CLI)`: un terminal propio que arranca `claude`/`opencode`).
* **Cerrar un panel de terminal cierra su sesión en el Core; cerrar la app no** (CA-03).
* **E2E real (Electron+CDP) 24/24, repetido 2 veces:** barra con un botón por modelo y CLI; 2 terminales aislados (cada uno ve solo su salida); 2 paneles de agente con su propio run y worktree; cada panel muestra solo su run; revisión y fusión desde el panel; conflicto informado sin perder nada; colocación sin solapes; arrastrar (ajustado a la cuadrícula) y redimensionar; notas; cierre de la app con Core y terminales vivos; reapertura con 7 paneles, posiciones, notas y **cada terminal reconectado a su propia sesión con scrollback**; cerrar un panel mata su terminal.
* **Corregido en el camino:** la comprobación de salida de agente tras reabrir esperaba el texto del prompt (solo existe en cliente); ahora comprueba el contenido real persistido del run.
* **No verificado:** la sesión interactiva real de `claude` (requiere iniciar sesión, pendiente del usuario) y `opencode (CLI)` dentro de su panel; ver el lienzo con 8+ paneles en monitor pequeño; arrastrar con ratón físico (el E2E sintetiza eventos de puntero); el agente de los E2E es el simulado.
* **Pendiente razonable:** salida de agentes por WebSocket en vez de sondeo cada 2 s, atajos de teclado, agrupar paneles por "espacios" como Deska, y pestañas/zoom del lienzo.

### PoC-9 · Claude Code con sesión real (suscripción Pro) · 2026-10-19 — **Cumple (adaptador) / Parcial (CLI interactivo)**
* **Autenticación:** `claude auth login` hecho por el usuario (`loggedIn: true`, `authMethod: claude.ai`, plan Pro). El adaptador no usa API key ni lee tokens: hereda la sesión del CLI oficial. Es la forma esperada por D-09.
* **Salida real capturada** (`claude -p … --output-format stream-json --verbose --permission-mode plan`, v2.1.220): `system/init` y otros subtipos de `system` (`thinking_tokens`, `post_turn_summary`), `assistant` con bloques `thinking`, `tool_use` y `text`, `rate_limit_event` (`status: allowed`, `rateLimitType: five_hour`), `user/tool_result` y `result`. El parser ignora lo que no necesita y **coincidió sin cambios**; la salida quedó como fixture real (`test/fixtures/claude-real.jsonl`) con 3 pruebas de contrato.
* **Panel "Claude Code" en la app (E2E real, `apps/desktop/scripts/e2e-claude.mjs`):** el run llega a `completed`, el panel muestra `▶ Read`, el resultado de la herramienta ("hola mundo") y la respuesta final.
* **Panel "Claude Code (CLI)":** arranca la interfaz interactiva real (`Welcome to Claude Code v2.1.220`) en su propio terminal/panel y se mantiene. **Bug corregido:** el comando `claude` se escribía a los 1,8 s, antes de que PowerShell estuviera listo, y a veces se perdía; ahora se envía cuando el shell está listo (salida inicial + 500 ms sin datos).
* **Pendiente (acción del usuario):** el CLI interactivo muestra su **asistente de primer uso (elegir tema)**; no se eligió por el usuario porque cambia su configuración global. Hasta completarlo una vez en el panel no se pudo probar un prompt interactivo (`e2e-claude.mjs` lo omite con un aviso y lo ejecuta después).
* **No verificado aún:** manifestación real de un límite de cuota (solo se vio `rate_limit_event` en estado `allowed`), `--resume`, y aprobaciones interactivas (el adaptador declara `interactiveApprovals=false`).
* **Flakiness reiterada:** otra vez, la primera ejecución de `test:win` justo después de un E2E (mientras se cierran Electron/Core) falló 4 pruebas de matar procesos/reconciliación; aisladas 42/42 dos veces y la suite completa 119/119 dos veces. Sigue pendiente volver esas pruebas tolerantes a carga.
