# 01 · Análisis de viabilidad técnica

> Fecha de elaboración y de consulta de fuentes: **2026-10-18**.
> Documento base analizado: `AI_Workspace_Especificacion_Tecnica_Completa.docx` (v1.0, 842 líneas, 8 figuras).
> Estado: **investigación y planificación. No se ha creado código de producto.**

## 0. Cómo leer este documento (honestidad sobre la evidencia)

Cada afirmación técnica lleva una marca de nivel de evidencia:

| Marca | Significado |
|---|---|
| ✅ **Fuente primaria** | Leí el texto oficial (documentación o archivo del repositorio) durante esta sesión. |
| 🔎 **Secundaria** | Solo apareció en resultados de búsqueda / resúmenes / sitios de terceros. Hay que confirmarla. |
| 🧠 **Conocimiento previo** | No pude verificarla en esta sesión (varios dominios, p. ej. `learn.microsoft.com`, `developers.openai.com`, `opencode.ai`, `geminicli.com`, no resolvían desde el entorno). Tratar como hipótesis. |
| 🧪 **Probado aquí** | Lo ejecuté en este entorno (Linux). |

**Límite importante:** este entorno es Linux sin Windows ni Android. **No he podido ejecutar ninguna prueba de escritorio remoto, ConPTY ni UAC.** Todo lo relativo a Windows/Android es análisis documental y queda como *Probable* o *Experimental* hasta pasar el PoC del doc `09`.

---

## 1. Resumen ejecutivo

1. **El proyecto completo es técnicamente viable**, pero no "todo es igual de seguro". La parte de agentes, worktrees, persistencia y panel móvil es ingeniería conocida con piezas maduras. **La parte de riesgo real es el escritorio remoto integrado dentro de nuestra app Android** (no el escritorio remoto en sí).
2. **Controlar toda la PC Windows desde Android es posible hoy** con herramientas existentes (RustDesk, Sunshine + Moonlight), porque capturan la sesión de consola real. **No es posible hacerlo con RDP nativo como solución principal**: RDP crea una sesión distinta de la que ve el usuario, y el Chrome que abre un agente en la sesión de consola no aparecería (ver §5.3).
3. **Integrar ese visor *dentro* de la app** es la parte difícil: no hay un SDK embebible oficial de RustDesk (✅ su núcleo es AGPL-3.0 y su cliente Android es Flutter+Rust); Moonlight sí es un cliente Android nativo reutilizable (✅ GPL-3.0) pero está orientado a juegos. Para **uso personal sin redistribución**, las licencias copyleft no son un impedimento práctico; si algún día se distribuye la app, se debe liberar el código (§5.4).
4. **Decisión provisional:** MVP con **RustDesk autoalojado sobre Tailscale como cliente externo lanzado desde nuestra app** (ruta A del documento); contingencia: módulo nativo propio basado en **Moonlight (moonlight-common-c) + Sunshine** (ruta B). La elección definitiva depende del PoC (doc `09`). Hasta entonces es **hipótesis, no hecho**.
5. **Hallazgos críticos que corrigen el documento original** (detalle en §3): el Core **no puede ser un servicio de Windows normal** si los agentes deben abrir navegadores visibles (Session 0); los PTY deben vivir en el Core, no en Electron; la aprobación de permisos **no es uniforme** entre proveedores; y la **autenticación con suscripción Claude está restringida** para productos de terceros.
6. **Estimación:** MVP verificable (Etapas 0–5a) en ~13–19 semanas de trabajo constante de una persona con asistencia de IA; producto completo con coordinador y endurecimiento 5–8 meses. Son estimaciones orientativas, no compromisos.

---

## 2. Inventario de requerimientos del documento

El documento define 12 RF (RF-01…RF-12) y 6 grupos de calidad. Clasificación mía tras el análisis (los IDs y estados definitivos están en `05-REQUERIMIENTOS.md`):

| Req. | Resumen | Prio. doc | Estado de viabilidad |
|---|---|---|---|
| RF-01 | Proyectos locales | P0 | Confirmada |
| RF-02 | Paneles editor/terminal/web/diffs/agentes | P0 | Confirmada (webview con restricciones) |
| RF-03 | Lanzar/detener agentes con salida en vivo | P0 | Confirmada (Claude, Codex, OpenCode, Gemini) |
| RF-04 | Agentes concurrentes y sesiones | P0 | Probable (límite = recursos y cuotas) |
| RF-05 | Worktrees por tarea | P0 | Confirmada 🧪 |
| RF-06 | Diff, pruebas, aprobación de merge | P0 | Confirmada |
| RF-07 | Android por red privada | P0 | Probable (Tailscale + pairing propio) |
| RF-08 | Ver y controlar pantalla Windows completa | P0 | Probable vía app externa; **Experimental** si debe estar embebida |
| RF-09 | Gestionar tareas/agentes desde Android | P1 | Confirmada |
| RF-10 | Reanudar sesiones | P1 | Probable (depende de cada CLI) |
| RF-11 | Orquestación automática | P2 | Probable (motor propio) |
| RF-12 | Push, voz, multi-monitor | P2 | Probable / Experimental según subfunción |

---

## 3. Contradicciones, omisiones y decisiones incompletas del documento

| # | Hallazgo | Impacto | Corrección propuesta |
|---|---|---|---|
| C-01 | **Sprint 0 (§16 paso 27) abre `node-pty` desde Electron**, pero **CA-03** exige que cerrar Electron no termine las sesiones. Si el PTY pertenece al proceso de Electron muere con él. | Alto | **El PTY vive en el Core**; Electron/Android solo son vistas (xterm.js conectado por WebSocket). Patrón análogo al "pty host" de VS Code (🧠). |
| C-02 | **§13.1 dice que Core puede ser "servicio configurable"**, pero los agentes deben abrir Chrome *visible* (§6.2). Un servicio de Windows corre en **Session 0**, aislada y sin escritorio interactivo (🔎 FireDaemon; Microsoft ha ido eliminando capacidades de Session 0). | Alto | Core = **proceso de usuario** iniciado al iniciar sesión (Tarea Programada "al iniciar sesión") con supervisor. Solo el *host remoto* se instala como servicio. Ver `03` §6. |
| C-03 | **Orden contradictorio:** el roadmap dice "Fase 0 = PoC remoto", pero el Sprint 0 hace primero monorepo/Core/Electron y deja el PoC en el paso 28. | Medio | PoC remoto es el **primer** entregable (doc `07` Etapa 0). |
| C-04 | **`respondToApproval` no es una capacidad uniforme.** Claude Agent SDK tiene `canUseTool` ✅; OpenCode tiene endpoint de respuesta de permisos ✅; Codex `app-server` envía *requests* de aprobación 🔎; pero `codex exec` y el modo headless de Gemini deciden por flags, sin aprobación interactiva. | Alto | Contrato con **capabilities** declaradas por adaptador; la UI muestra qué soporta cada uno. |
| C-05 | **"Principio central" prohíbe abrir apps dentro de Electron**, y a la vez RF-08 (P0) y la ruta B pide visor "embebido". La ruta A abre una **segunda app**. | Medio | Aclarar: P0 = *capacidad* de ver/controlar; *embeber* es objetivo posterior (CA-06 no exige embeber). |
| C-06 | **Expo "estándar" vs. visor nativo:** el documento ya lo apunta, pero omite que **Expo Go no sirve** en cuanto haya módulos nativos propios; se requiere *Development Build* (🔎 documentación Expo vía buscador). | Medio | Usar Expo Dev Build + Expo Modules API desde el inicio. |
| C-07 | **Tailscale se trata como solución cerrada.** Omite: dependencia de un tercero (plano de control, identidad), y que Android solo admite **una VPN activa** (🧠), lo que choca con otras VPN. | Medio | Documentado como riesgo; alternativa autoalojada (Headscale / WireGuard) en `10`. |
| C-08 | **Cuentas y límites de proveedores** ("cuentas/CLI autorizadas") sin concretar. Anthropic indica que los productos de terceros que usen el Agent SDK deben usar **API key** y que no permite ofrecer login/límites de claude.ai (✅ `code.claude.com/docs/en/agent-sdk/overview`; 🔎 página legal). | Alto | Decisión explícita en `10` (D-09): Claude vía API key, o CLI propio del usuario sin que nuestra app maneje credenciales. Consultar términos antes de usar suscripción. |
| C-09 | **Windows y `.cmd`:** CLIs instalados por npm son shims `.cmd`; `spawn` sin shell sobre `.cmd` está restringido por seguridad en Node (CVE-2024-27980, 🧠). El documento pide "spawn seguro" pero no resuelve esto. | Medio | Resolver el ejecutable real/entrypoint JS, probar en PoC-5. |
| C-10 | **Notificaciones push (RF-12)** sin servidor público: FCM requiere proyecto Firebase y salida a Internet desde el Core. | Bajo | Opciones en `07`: FCM, ntfy autoalojado, o WebSocket + servicio en primer plano. |
| C-11 | **Falta política de límites de concurrencia basada en recursos** (el documento solo dice "limitar número"). | Medio | Planificador con presupuesto de RAM/CPU y semáforo por proveedor (`03` §7). |
| C-12 | **`packages/remote-bridge` en la estructura** antes de decidir tecnología. | Bajo | No crear hasta cerrar el PoC. |
| C-13 | **Monaco y webviews:** el documento incluye un "navegador" en los paneles; no define cómo se aísla contenido localhost no confiable en Electron. | Medio | `WebContentsView` aislado con sandbox, sin preload y sin Node (`06`). |

**Actualización 2026-10-18 sobre C-08:** el usuario usa suscripción en los cuatro agentes; la decisión resultante (CLI oficial sin modificar, SDK solo con API key, planificación por cuotas) está en `10` D-09 y D-16, con lectura de la política oficial de Anthropic (✅ `code.claude.com/docs/en/legal-and-compliance`).

Omisiones: política de **actualización de CLIs** de agentes (los eventos cambian entre versiones), **telemetría de costos** por run, **encadenamiento de permisos** para comandos de red, y **modo "dry-run"** del coordinador. Se cubren en `03`/`06`.

---

## 4. Investigación por área

### 4.1 Aplicación de escritorio

| Pieza | Evaluación | Evidencia |
|---|---|---|
| Electron | Adecuado. Precedente: VS Code (Electron + Monaco + xterm.js + node-pty). Consumo de RAM por ventana alto (Chromium); aceptable para una app personal. | 🧠 |
| React + TS + Vite | Estándar, sin incompatibilidades conocidas con Electron. | 🧠 |
| Tailwind + shadcn/ui | Compatibles; shadcn copia componentes al repo (sin dependencia de runtime). | 🧠 |
| React Flow (XYFlow) | Válido para el lienzo; el doc ya lo pospone tras el MVP. Acierto. | 🧠 |
| Monaco | Funciona en Electron; pesado (varios MB). Cargar bajo demanda. | 🧠 |
| xterm.js | Terminal en renderer; usar con addon WebGL/canvas y *flow control*. | 🧠 |
| node-pty | ✅ MIT; Windows usa **ConPTY** y exige **Windows 10 build 18309+**; ✅ requiere toolchain C++/Spectre en Windows para compilar; ✅ "no es thread-safe"; ✅ procesos hijos con los mismos permisos del padre; ✅ PowerShell puede fallar con error `8009001d` si falta `SystemRoot`. 🧪 Funciona en Linux (spawn/kill). | ✅ README / 🧪 |

**Ventaja de arquitectura:** si `node-pty` y `better-sqlite3` viven en el Core (Node puro) y no en Electron, **no hay que recompilarlos contra la ABI de Electron** (`@electron/rebuild`, 🔎 documentación de Electron) — reduce fricción de actualizaciones.

### 4.2 Integración de agentes

| Agente | Modo programático | Sesiones | Permisos | Cancelación | Licencia/Auth | Evidencia |
|---|---|---|---|---|---|---|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` (`query()` → `AsyncGenerator<SDKMessage>`); también CLI `-p` + `--output-format stream-json` | `resume`, `continue`, `sessionId`, `forkSession`, `persistSession`, `listSessions()` | `canUseTool`, `permissionMode` (`default`/`acceptEdits`/`plan`/`dontAsk`/`auto`/`bypassPermissions`), reglas `allowedTools`/`disallowedTools` | `abortController`, `Query.interrupt()` (solo modo streaming), `Query.close()` | Términos comerciales; **API key para productos de terceros**; no se permite ofrecer login claude.ai salvo aprobación | ✅ |
| **OpenAI Codex** | `codex exec --json` (JSONL: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`…); `codex app-server` (JSON-RPC por stdio: `initialize`→`thread/start`→`turn/start`, notificaciones `item/*`, `turn/completed`) | `codex exec resume <id>/--last`; `thread/resume` | En `app-server`, aprobaciones llegan como *requests* JSON-RPC (`item/commandExecution/requestApproval`); en `exec` por flags de sandbox | `thread/interrupt`/señal al proceso (🧠 confirmar) | Licencia del repo (🧠 Apache-2.0, confirmar); auth ChatGPT o API key | 🔎 (README del app-server leído parcialmente ✅: confirma `thread/start`, `turn/start` y que partes requieren `experimentalApi`) |
| **Gemini CLI** | `-p` + `--output-format json|stream-json` (eventos `init`, `message`, `tool_use`, `tool_result`, `error`, `result`; códigos de salida 0/1/42/53); **`gemini --acp`** (JSON-RPC 2.0 por stdio: `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`) | `loadSession` (ACP) | Modos de aprobación vía ACP `setSessionMode`; en headless por flags | `cancel` (ACP) / señal | 🧠 Apache-2.0; auth Google/API key | ✅ (headless y ACP leídos en el repo) |
| **Antigravity (`agy`)** | CLI con modo headless `--input-format/--output-format stream-json` (eventos `init`, `step_update`, `result`), SDK de Python; **sin `--acp` nativo** (hay puentes de la comunidad) | Por verificar | `permission_mode` (`request-review` por defecto; `--dangerously-skip-permissions` existe) | Por verificar | Producto de Google; licencia y límites sin verificar | 🔎 (solo búsqueda; su documentación oficial no cargaba desde el entorno) |
| **OpenCode** | `opencode serve` (HTTP+OpenAPI 3.1 en `/doc`), SDK `@opencode-ai/sdk`, SSE en `/event` | `POST /session`, `fork`, `revert`, `prompt_async` | `POST /session/:id/permissions/:permissionID {response, remember?}` | `POST /session/:id/abort` | ✅ **MIT**; auth básica con `OPENCODE_SERVER_PASSWORD` | ✅ |

**Protocolo común candidato: ACP (Agent Client Protocol).** 🔎 Creado por Zed (ago. 2025), JSON-RPC 2.0 sobre stdio; Gemini CLI es la implementación de referencia ✅ (`gemini --acp`); existen adaptadores para Claude y Codex (`@zed-industries/claude-agent-acp`, `@zed-industries/codex-acp`, nombres 🔎 a verificar) y OpenCode lo soporta de forma nativa 🔎. **Valor:** un único adaptador ACP podría cubrir varios proveedores. **Riesgo:** ACP es joven; los adaptadores de terceros pueden quedar por detrás de las funciones nativas. Decisión (D-05): *adaptadores nativos* para Claude y Codex (más capacidades), *adaptador ACP genérico* para Gemini/OpenCode y futuros agentes; todos tras la misma interfaz de dominio.

**Lo que no es uniforme (y la UI debe respetar):** aprobación interactiva, reanudación fiel, eventos de coste/tokens, subagentes, edición de plan. Cada adaptador publica un objeto `capabilities` (ver `03`).

**Límites de uso y costos:** cada proveedor aplica cuotas/rate limits (429) propios; el coste real depende de modelo y tokens (§8 Costes). Anthropic indica que `claude -p`/Agent SDK consumen los límites de suscripción en el estado actual (🔎, y el cambio anunciado de créditos aparece *pausado*; verificar antes de depender de él).

### 4.3 Ejecución multiagente

* **¿2, 5, 10 o más?** Técnicamente no hay un tope inherente: cada agente es un proceso (o petición HTTP) independiente. El límite lo ponen (1) **RAM/CPU**, (2) **cuotas y rate limits del proveedor**, (3) **E/S de disco** de los worktrees, (4) **capacidad humana de revisar diffs**.
* **No existen cifras públicas verificadas** de RAM por agente que pueda citar; cualquier número que diera sería inventado. Se medirá (PoC-6) y el planificador usará **presupuesto dinámico**: no iniciar un run si `RAM libre < umbral` o `carga CPU > umbral`, con semáforos por proveedor.
* Aislamiento por **Git worktrees** 🧪: probé 3 worktrees con commits concurrentes en el mismo repo sin interferencia; un merge de dos ramas que tocan la misma línea produce conflicto detectable (`UU`) y `git merge --abort` lo revierte; `git worktree remove` **rechaza borrar** un worktree con cambios sin confirmar salvo `--force`. Esto respalda las reglas 8.11–8.18 del documento.
* Limitación de worktrees (🧠): una misma rama no puede estar en dos worktrees a la vez; `node_modules` y artefactos no se comparten (coste de disco/instalación por worktree → estrategia de caché/`pnpm` store).

### 4.4 Orquestación

* Evaluado: **motor propio** vs **LangGraph (JS)** vs otras. Conclusión: **motor propio mínimo** (DAG + planificador + máquina de estados, persistido en SQLite). Razones: el estado ya vive en nuestra BD; LangGraph aporta checkpointing duplicado y acopla a su modelo; la lógica requerida (dependencias, paralelismo limitado, reintentos, aprobación humana) es pequeña. Sin evidencia ✅ de LangGraph en esta sesión → solo criterio de diseño 🧠.
* El **coordinador es un agente LLM que solo produce un plan JSON validado por esquema** (Zod). Nunca ejecuta cambios; el **Scheduler determinista** (código nuestro) los ejecuta tras aprobación. Esto cumple "no modificar indiscriminadamente ni fusionar automáticamente".

### 4.5 Control remoto completo de Windows — análisis riguroso

(Resumen; detalle y matriz en §5 y en `09`.)

### 4.6 Android

| Opción | Streaming remoto | Módulos nativos | Notificaciones | Veredicto |
|---|---|---|---|---|
| **React Native + Expo (Dev Build)** | Vía módulo nativo propio (Expo Modules API) o app externa | Sí (Dev Build / config plugins) ✅ 🔎 | FCM / `expo-notifications` | **Elegida** |
| React Native "bare" | Igual | Sí | Igual | Alternativa si Expo estorba |
| Kotlin nativo (Compose) | Mejor integración con Moonlight/MediaCodec | Total | Total | Mejor para el visor; peor reutilización de contratos TS |
| Flutter | Natural si se forkea el cliente RustDesk (Flutter) | Sí | Sí | Solo si se escoge ruta B con RustDesk |
| PWA | **No** puede hospedar un decodificador de Moonlight/RustDesk; WebRTC solo con host propio | Limitado | Web Push limitado | Útil **solo** como respaldo para panel de agentes |

Expo Go **no** admite módulos nativos propios (🔎); hace falta Development Build, que se recompila al añadir dependencias nativas. Esto no es un problema para una app personal sideload (APK), y no requiere Google Play.

### 4.7 Backend independiente

* Node.js LTS + Fastify + `@fastify/websocket` (🧠). Proceso aparte de Electron.
* **No como servicio Session 0** (C-02). Opciones evaluadas: (a) Tarea Programada al iniciar sesión + supervisor (**elegida**), (b) servicio de Windows + *helper* lanzado en la sesión del usuario (complejo; solo si se necesitara operar sin login), (c) Electron con proceso hijo (viola independencia).
* Distinguir: **cerrar la UI** (Core y agentes siguen) ≠ **detener el Core** (agentes hijos se cancelan o se marcan *huérfanos*) ≠ **cerrar sesión de Windows** (todo muere salvo servicios) ≠ **suspender/apagar** (nada corre; el acceso remoto no existe, §9.2 del documento correcto).
* Para sobrevivir a reinicio del Core: ejecutar agentes en procesos **desacoplados** (job object / proceso independiente) para poder reconectar. En Windows, matar el árbol requiere *Job Objects* o `taskkill /T` (🧠).

### 4.8 Persistencia

SQLite (WAL) + Drizzle: viable. 🧪 Probé 4 escritores concurrentes (20 000 filas) en WAL y una copia con la API de backup de SQLite: `integrity_check = ok`. **Matiz honesto:** la inserción terminó en 0,22 s, antes de que el backup se solapara de forma significativa; es evidencia débil del backup *bajo carga*. Se repetirá con carga sostenida en PoC-7. Estrategia completa (retención, tablas de logs, particionado por archivos NDJSON, migraciones) en `03` §9.

---

## 5. Matriz de viabilidad del escritorio remoto

### 5.1 Candidatos

| Tecnología | Captura sesión de consola real | Entrada (mouse/teclado) | Android | Integrable en nuestra app | Licencia | Evidencia |
|---|---|---|---|---|---|---|
| **RustDesk** | Sí (host Windows) 🔎 | Sí | Cliente Android propio (Flutter) | **No hay SDK embebible oficial** localizado; forkear el cliente o lanzarlo como app externa | ✅ **AGPL-3.0**; versión *Pro* del servidor es propietaria 🔎 | ✅ licencia, README (arquitectura rendezvous/relay, Flutter, libvpx/libyuv/opus/aom) |
| **Sunshine + Moonlight** | Sí (Sunshine corre como servicio, ✅ docs) | Sí (mouse, teclado; ✅ "absolute positioning usa inyección de entrada de Windows") | **moonlight-android** nativo, ✅ GPL-3.0 | **Viable**: módulo nativo sobre `moonlight-common-c` o fork del cliente | ✅ Sunshine **GPL-3.0** (✅ nota: la licencia **no concede derechos sobre los codificadores**; redistribución comercial exige licencias de códec); ✅ moonlight-android GPL-3.0 | ✅ |
| **RDP nativo** | **No**: crea sesión propia distinta de la consola 🧠 | Sí | Clientes (Windows App / FreeRDP) | FreeRDP ✅ Apache-2.0 es embebible | Windows **Home no puede ser host** 🔎 | 🔎/🧠 |
| RDP *shadowing* (`mstsc /shadow`) | Sí, de sesión activa | Sí | Clientes móviles no envían ese parámetro 🔎 | No práctico | Requiere Pro/Enterprise y reglas de firewall 🔎 | 🔎 |
| **VNC** (TightVNC/UltraVNC/TigerVNC) | Sí | Sí | Clientes OSS | Sí (varias licencias GPL) | GPL (🧠) | 🧠 |
| **WebRTC propio** | Hay que escribir captura (Desktop Duplication API), entrada, códecs, señalización | — | Sí | Total | Libre | No recomendado para MVP (el propio documento coincide) |
| **Apache Guacamole** | Es *gateway* a RDP/VNC; hereda sus límites | Sí | Solo cliente web | Web | ✅🔎 Apache-2.0 | 🔎 |
| Parsec, Chrome Remote Desktop, AnyDesk | Sí | Sí | Sí | **Sin SDK abierto** para embeber | Propietarias | 🧠 |

### 5.2 Escritorios seguros: UAC, bloqueo, inicio de sesión

* Windows presenta UAC, Ctrl+Alt+Supr y la pantalla de bloqueo en el **escritorio seguro** (🔎). Una herramienta que solo captura el escritorio normal ve **negro** o pierde la entrada ahí.
* RustDesk documenta que una versión **portable sin privilegios no puede capturar la pantalla cuando aparece UAC** y el ratón no responde sobre ventanas elevadas (p. ej. Administrador de tareas); para evitarlo hay que elevar (🔎 `rustdesk.com/docs/en/client/windows/windows-portable-elevation`). La guía de acceso desatendido recomienda **instalarlo como servicio** para conectarse incluso en la pantalla de inicio de sesión (🔎); **no he podido verificar** que el modo servicio controle el UAC → *Probable, requiere PoC*.
* Para Sunshine, su documentación **no menciona** UAC/escritorio seguro/bloqueo (✅ revisé `troubleshooting.md`: solo señala que corre como servicio SYSTEM con menos acceso que el usuario). → *Probable, requiere PoC*.
* **Sin monitor físico:** Windows puede desactivar el adaptador gráfico sin monitor; típica solución: *dummy plug* HDMI o controlador de pantalla virtual (🧠). Sunshine/Apollo (fork) mencionan pantalla virtual (🔎, "requires Apollo"). Probar.

### 5.3 Por qué RDP no sirve como solución principal

El caso de uso central (§6.2 del documento) es: *un agente abre Chrome en el escritorio de Windows y yo lo veo desde el teléfono*. Con RDP, conectarse **abre otra sesión** y bloquea/desconecta la sesión de consola (🔎 hilo de Microsoft Q&A sobre clientes móviles que desconectan la consola). El Chrome lanzado por el agente en la consola **no estaría en la sesión RDP**. La alternativa (hacer que el agente trabaje *dentro* de la sesión RDP) cambia el modelo de la aplicación y no cubre "ver mi PC". Además Windows Home no actúa de host RDP (🔎).

### 5.4 Licencias: ¿podemos integrarlo "legal y técnicamente"?

* **Uso personal sin distribuir el binario ni darlo a terceros:** GPL/AGPL imponen obligaciones al **distribuir** (o, en AGPL §13, al ofrecer interacción por red a *otros usuarios*: ✅ el texto de AGPL-3.0 lo dice). Un único usuario propietario que compila su fork para sí mismo no activa esas obligaciones (🧠 interpretación estándar; **no es asesoramiento legal**).
* **Si algún día se distribuye la app** (a amigos, tienda, cliente): el código derivado debe publicarse bajo la misma licencia; en Sunshine además aplican licencias de códec (✅ nota de LizardByte).
* **Marca y términos:** no usar el nombre/branding "Claude Code" (✅ directrices de marca del Agent SDK).
* **Vía de menor riesgo legal:** invocar RustDesk/Moonlight como **aplicaciones externas separadas** (no combinadas con nuestro código) o proceso aparte comunicado por IPC.
* **Alternativa permisiva:** FreeRDP (✅ Apache-2.0) es embebible sin copyleft, pero no resuelve la limitación de sesión (§5.3) por sí solo.

### 5.5 Qué demuestra y qué no esta investigación

**No he demostrado** que RustDesk o Moonlight funcionen en el hardware del usuario, que superen UAC, o que la latencia sea aceptable. La afirmación "es posible controlar Windows desde Android" se apoya en que **ambas herramientas existen y capturan la consola** (documentación + uso extendido), no en una prueba propia. Por eso el doc `09` define PoC-1…PoC-4 con criterios de aceptación medibles y **nada de ello se da por cumplido**.

---

## 6. Matriz de viabilidad (Fase 8)

Categorías: **Confirmada** (documentación + mecanismo concreto), **Probable** (razonable, requiere prueba), **Experimental** (obstáculos sin resolver), **No viable actualmente** (limitación técnica/legal documentada).

| Funcionalidad | Viabilidad | Dificultad | Tecnología | Riesgo | Prueba necesaria | Justificación |
|---|---|---|---|---|---|---|
| Proyectos locales + workspace persistido | Confirmada | Baja | SQLite/Drizzle | Bajo | Smoke test | Tecnología estándar |
| UI de paneles (Electron, Monaco, xterm) | Confirmada | Media | Electron/React | Rendimiento RAM | Medir RAM con 8 paneles | Precedente VS Code 🧠 |
| Terminal real en Windows | Confirmada | Media | node-pty/ConPTY | Compilación nativa, `SystemRoot`, kill de árbol | PoC-5 en Windows | ✅ README node-pty |
| Core independiente de Electron | Confirmada | Media | Node+Fastify | Mal diseño de ciclo de vida | CA-03 | Arquitectura estándar |
| Core como servicio Windows (Session 0) | **No viable** para agentes con GUI | — | — | — | — | 🔎 Session 0 aislada; usar proceso de usuario |
| Agente Claude (SDK) | Confirmada | Media | `claude-agent-sdk` | Auth/terminos | Adaptador + prueba de cancelación | ✅ docs |
| Agente Codex | Confirmada (exec) / Probable (app-server) | Media | `exec --json`, `app-server` | `experimentalApi`, cambios de protocolo | Adaptador con contrato por versión | ✅/🔎 |
| Agente Gemini CLI | Confirmada | Media | headless / ACP | Aprobaciones limitadas en headless | Prueba ACP vs headless | ✅ |
| Agente OpenCode | Confirmada | Baja | `opencode serve` + SDK | Seguridad del servidor local | Auth + loopback | ✅ MIT |
| Adaptador ACP genérico | Probable | Media | ACP | Inmadurez, divergencia | PoC con 2 agentes | 🔎 |
| N agentes en paralelo | Probable | Media | Scheduler propio | RAM/cuotas | PoC-6 (carga) | Sin cifras públicas |
| Worktrees por tarea | Confirmada | Baja-Media | git CLI | Disco, node_modules, conflictos | 🧪 hecho; repetir en Windows (rutas largas) | 🧪 |
| Reanudación de sesiones | Probable | Media | resume/loadSession | No fidelidad idéntica | Pruebas por CLI | ✅ SDK / ✅ ACP |
| Orquestador (plan→DAG→ejecución) | Probable | Alta | Motor propio + LLM | Planes malos, bucles, coste | Evaluación con repos de prueba | Diseño propio |
| Integración/merge asistido | Confirmada | Media | git | Errores semánticos | Tests post-merge | Doc coincide |
| Android: panel de agentes | Confirmada | Media | RN+Expo Dev Build | Mantenimiento | Prototipo | ✅ |
| Acceso privado Android↔PC | Probable | Media | Tailscale | Una sola VPN en Android 🧠, tercero | CA-05 | 🔎 |
| Emparejamiento/revocación de dispositivos | Confirmada | Media | Claves Ed25519 + Keystore | Implementación errónea | Pruebas de seguridad | Estándar |
| **Ver/controlar Windows completo (app externa)** | **Probable** | Media | RustDesk o Sunshine+Moonlight | UAC, bloqueo, sin monitor | **PoC-1…4** | Existe y captura consola; sin prueba propia |
| **Visor embebido en nuestra app** | **Experimental** | Alta | Módulo nativo (Moonlight) o fork RustDesk (Flutter) | Licencias copyleft, mantenimiento, NDK | PoC-8 tras elegir | Sin SDK oficial embebible |
| Controlar UAC/pantalla de bloqueo | **Experimental** | Alta | Host como servicio | Escritorio seguro | PoC-3 | Documentación incompleta |
| Multi-monitor | Probable | Media | Selector de pantalla en cliente | UX | PoC-4 | |
| Notificaciones push | Probable | Media | FCM / ntfy | Dependencia externa | Prueba | |
| Voz | Experimental | Media | STT en Android | Fuera de MVP | — | |
| Backups/restore SQLite | Confirmada | Baja | API backup / `VACUUM INTO` | Restauración sin probar | 🧪 parcial; test de restauración | |
| Retención de logs | Confirmada | Media | NDJSON rotado + tabla índice | Crecimiento | Test de volumen | |
| Auto-actualización | Probable | Media | electron-updater u otro | Firma, rollback | Prueba de actualización | Doc ya lo pide probada |

---

## 7. Respuestas a las 15 preguntas finales

1. **¿Es técnicamente posible construir AI Workspace con todas las funcionalidades?** Sí, con una salvedad: el **visor de escritorio embebido** es *Experimental*; el requisito de *ver y controlar* es alcanzable mediante app externa. Voz y lienzo avanzado son P2.
2. **¿Se puede controlar toda la PC Windows desde Android?** Sí con RustDesk o Sunshine+Moonlight (capturan la consola); **pendiente de confirmar** UAC/bloqueo con PoC. No con RDP nativo como vía principal (§5.3).
3. **¿Solución para el escritorio remoto?** Provisional: **RustDesk autoalojado sobre Tailscale (cliente externo)** para el MVP; **Sunshine + módulo nativo basado en Moonlight** como camino a la integración. Decide el PoC con criterios cuantitativos (`09`).
4. **¿Múltiples agentes de distintos proveedores a la vez?** Sí; cada uno tiene SDK/modo programático documentado (✅ Claude, Gemini, OpenCode; ✅/🔎 Codex). Límite = recursos y cuotas.
5. **¿Agente coordinador que distribuya tareas?** Sí, como *planificador determinista + LLM que emite plan validado*, con aprobación humana. Requiere evaluación con repos reales.
6. **Mayores dificultades:** (1) visor embebido; (2) UAC/bloqueo/sin monitor; (3) fiabilidad del coordinador; (4) aprobación heterogénea entre proveedores; (5) estabilidad de protocolos de CLIs (cambian rápido); (6) licencias/auth de proveedores.
7. **Stack más adecuado:** ver `02` (Electron+React+TS, Core Node/Fastify, SQLite+Drizzle, RN+Expo Dev Build, Tailscale, adaptadores nativos + ACP).
8. **Problemas de compatibilidad:** Expo Go vs módulos nativos; node-pty/`better-sqlite3` en Electron (evitado al ponerlos en el Core); `.cmd` en Windows; Android con una sola VPN; ConPTY exige Win10 1809+; codec/licencias de Sunshine; AGPL/GPL si se distribuye.
9. **Costos reales:** software base gratuito/open source; costo variable = **uso de modelos** (API o suscripción, sujeto a cuotas), posible hardware (RAM, dummy plug ~ decenas de USD 🧠), Tailscale Personal gratuito según fuente secundaria (🔎 verificar), sin costo de tienda si es sideload. Detalle en `08` §Costos.
10. **Tiempos:** `07` (MVP 13–19 semanas; completo 5–8 meses; estimaciones).
11. **Evitar que sea inmantenible:** contratos tipados compartidos, adaptadores aislados con pruebas de contrato por versión de CLI, backend independiente, límites de dependencias verificados en CI, migraciones versionadas, ADRs en `10`, y *no* construir lo que no se haya validado.
12. **MVP:** vertical mínima — Core + SQLite + 2 adaptadores (Claude, Codex) + worktrees + diff/aprobación + Electron mínimo + Android (emparejar, ver agentes, aprobar) + "Ver mi PC" por app externa.
13. **Pruebas antes de invertir:** PoC-1 a PoC-6 del doc `09` (remoto, UAC/bloqueo, latencia, adaptadores, concurrencia).
14. **Reutilizable de OSS:** Sunshine/Moonlight/`moonlight-common-c`, RustDesk (con copyleft), FreeRDP, node-pty, xterm.js, Monaco, `@opencode-ai/sdk`, SDK de Claude, esquemas de Codex app-server, ACP; ideas de Orca/Deska (producto, no código).
15. **Qué simplificar sin sacrificar lo esencial:** lienzo React Flow tras el MVP; voz fuera del MVP; coordinador tras agentes manuales; un solo OS host (Windows) y un cliente (Android); visor externo antes que embebido; motor propio mínimo en vez de framework.

---

## 8. Fuentes consultadas (2026-10-18)

✅ **Leídas en fuente primaria**
* RustDesk — `LICENCE` (AGPL-3.0): https://github.com/rustdesk/rustdesk/blob/master/LICENCE
* RustDesk — README: https://github.com/rustdesk/rustdesk
* Sunshine — `docs/legal.md`: https://github.com/LizardByte/Sunshine/blob/master/docs/legal.md
* Sunshine — `docs/troubleshooting.md`: https://github.com/LizardByte/Sunshine/blob/master/docs/troubleshooting.md
* moonlight-android — README y `LICENSE.txt` (GPL-3.0): https://github.com/moonlight-stream/moonlight-android
* FreeRDP — `LICENSE` (Apache-2.0): https://github.com/FreeRDP/FreeRDP
* OpenCode — `LICENSE` (MIT) y docs del servidor (`packages/web/src/content/docs/server.mdx`): https://github.com/sst/opencode
* Claude Agent SDK (TypeScript) — referencia y visión general: https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/agent-sdk/overview
* Gemini CLI — `docs/cli/headless.md` y `docs/cli/acp-mode.md`: https://github.com/google-gemini/gemini-cli
* Codex — `codex-rs/app-server/README.md` (lectura parcial): https://github.com/openai/codex
* node-pty — README (MIT): https://github.com/microsoft/node-pty

🔎 **Solo por búsqueda (confirmar antes de decidir)**
* Codex non-interactive: https://developers.openai.com/codex/noninteractive
* RustDesk — elevación en Windows: https://rustdesk.com/docs/en/client/windows/windows-portable-elevation/
* RustDesk — acceso desatendido: https://rustdesk.com/blog/rustdesk-unattended-access-setup
* Session 0 Isolation: https://www.firedaemon.com/post/microsoft-windows-interactive-services-and-session-0-isolation
* Windows Home y RDP host / shadowing: https://learn.microsoft.com/en-us/answers/a/12753520 , https://woshub.com/rdp-session-shadow-to-windows-10-user
* Expo Dev Builds: https://docs.expo.dev/
* Electron — módulos nativos: https://electronjs.org/docs/latest/tutorial/using-native-node-modules
* Tailscale (pricing; fuente de terceros): https://www.ssdnodes.com/learn/is-tailscale-free-plan-limits
* ACP: https://zed.dev/acp
* Política de Anthropic para terceros: https://code.claude.com/docs/en/legal-and-compliance
* Apache Guacamole: https://guacamole.apache.org/

🧪 **Pruebas propias:** ver `09-PRUEBAS-DE-CONCEPTO.md` §A.
