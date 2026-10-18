# 02 · Stack tecnológico

> Consulta de fuentes: 2026-10-18. Marcas de evidencia como en `01` (✅ primaria · 🔎 secundaria · 🧠 previa sin verificar · 🧪 probado).
> Versiones: **no fijo números de versión** porque no los verifiqué contra registros en vivo. Se fijarán con lockfile en la Etapa 1 tras comprobar compatibilidad (Electron ↔ Node ↔ Chromium; Expo SDK ↔ React Native).

## 1. Stack final seleccionado

| Capa | Elección | Cambio vs documento | Motivo resumido |
|---|---|---|---|
| Escritorio | Electron + React + TypeScript + Vite | = | Precedente VS Code 🧠; reutiliza TS del Core |
| UI | Tailwind CSS + shadcn/ui + Zustand (+ TanStack Query para estado de servidor) | + TanStack Query | Evita reescribir caché/reintentos |
| Lienzo | Paneles con layout propio; React Flow después del MVP | = | Reduce alcance inicial |
| Editor | Monaco (carga diferida) | = | |
| Terminal | xterm.js (renderer) + **node-pty en el Core** | **node-pty se mueve de Electron a Core** | CA-03; evita ABI de Electron |
| Core | Node.js LTS + Fastify + `@fastify/websocket` + Zod | + Zod | Contratos validados en runtime |
| Contratos | `packages/contracts` (Zod → tipos TS; esquema JSON/OpenAPI exportable) | + Zod | Una fuente de verdad para Electron, Android y Core |
| Datos | SQLite (WAL) + Drizzle ORM + `better-sqlite3` | driver explícito | Síncrono, rápido; backup API |
| Logs/salidas | Archivos NDJSON rotados + índice en SQLite | nuevo | La BD no crece con salidas grandes |
| Agentes | Adaptadores nativos (Claude SDK, Codex `exec`/`app-server`) + adaptador ACP genérico (Gemini, OpenCode, otros) | + ACP | Cubre más proveedores con un código |
| Orquestación | Motor propio mínimo (DAG + scheduler + FSM) | concreta "propio o framework" | Sin dependencia pesada |
| Git | `git` CLI vía `spawn` con argv | = | Worktrees 🧪 |
| Android | React Native + **Expo Development Build** + Expo Modules API | explicita Dev Build | Módulos nativos futuros |
| Red | Tailscale (Headscale como alternativa) + pairing propio | + pairing obligatorio | VPN ≠ autorización |
| Control remoto | **Provisional:** RustDesk (A) → Moonlight/Sunshine nativo (B) | decide PoC | Ver `01` §5 |
| Monorepo | pnpm workspaces (Turborepo opcional) | = | |
| Pruebas | Vitest, Playwright (Electron), Maestro/Detox opcional, pruebas de contrato por adaptador | + contract tests | CLIs cambian |
| Secretos | Windows Credential Manager/DPAPI (Core), Android Keystore (`expo-secure-store`) | concreta | Nunca en SQLite en claro |

## 2. Evaluación por componente (y alternativas)

### 2.1 Electron + React + TS + Vite
* **Por qué:** una sola lengua (TS) en Electron, Core y Android; ecosistema de Monaco/xterm.
* **Alternativas:** *Tauri* (menor RAM; WebView2 en Windows; Monaco/xterm funcionan, pero el sidecar Node/pty exige más integración Rust; sin la ventaja de contexto compartido de TS puro) 🧠; *WPF/WinUI* (nativo, pero se pierde Monaco/xterm directos). **Veredicto:** mantener Electron. Desventaja asumida: RAM de Chromium.
* **Riesgo:** actualizaciones de Electron/Chromium frecuentes → fijar versión y probar antes de actualizar.

### 2.2 Tailwind + shadcn/ui + Zustand
Compatibles y de bajo acoplamiento (shadcn se copia al repositorio). **Riesgo:** deriva de estilos → tokens de diseño centralizados.

### 2.3 Monaco y xterm.js
Usados juntos por VS Code 🧠. Monaco aporta *DiffEditor* (necesario para RF-06). xterm.js: control de flujo (*backpressure*) obligatorio al recibir salidas masivas; dimensionar buffer.

### 2.4 node-pty
✅ MIT, ConPTY (Win10 build ≥ 18309), toolchain C++ + librerías Spectre para compilar en Windows, no thread-safe, procesos con los permisos del padre. 🧪 spawn/kill verificado en Linux. **Alternativa:** `@homebridge/node-pty-prebuilt-multiarch` (binarios precompilados, 🔎 mencionado en un PR de terceros) evita compilar; evaluar mantenimiento antes de adoptarlo.
**Decisión:** node-pty vive en el Core, que es Node puro → sin `@electron/rebuild`.

### 2.5 Core: Fastify + WebSocket
* Fastify: esquemas JSON, rendimiento, plugins; alternativa *Hono*/*Express* (sin ventaja clara). 🧠
* WebSocket: eventos incrementales con `eventId` monótono y **reanudación por `lastEventId`**; HTTP para comandos. Evaluar *SSE* para móvil si WebSocket resulta frágil en cambios de red (SSE se reconecta nativamente) — decisión en PoC de red.
* **Validación en frontera:** Zod en cada ruta/mensaje.

### 2.6 SQLite + Drizzle + better-sqlite3
* ✅ conceptual: transaccional, WAL, API de backup. 🧪 WAL con 4 escritores y backup con integridad ok.
* *Drizzle*: migraciones versionadas generadas; riesgo de madurez de migraciones complejas → revisar SQL generado y probar migración sobre copia.
* Alternativas: `node:sqlite` integrado (estado experimental/estabilización según versión; 🧠 no verificado) — reevaluar; *Prisma* (motor binario adicional, innecesario).

### 2.7 Agentes
Detallado en `01` §4.2 y `03` §5. Criterio: **no inventar uniformidad**.
* **Claude:** `@anthropic-ai/claude-agent-sdk` ✅ (incluye binario nativo como dependencia opcional; si se omiten optionalDependencies hay que fijar `pathToClaudeCodeExecutable`). Auth: API key para producto (✅ política). Marca: no llamar a nuestra app "Claude Code" ✅.
* **Codex:** empezar con `codex exec --json` (simple, JSONL) y migrar a `app-server` si se necesitan aprobaciones interactivas/hilos; `app-server` tiene partes `experimentalApi` ✅ → fijar versión del CLI y generar tipos desde su esquema (🧠: el CLI ofrece generación de esquema; verificar comando).
* **Gemini:** `--acp` preferido; headless `stream-json` como respaldo ✅.
* **OpenCode:** `opencode serve` en loopback con `OPENCODE_SERVER_PASSWORD` ✅ y SDK generado desde OpenAPI ✅.
* **Otros dignos de consideración (🧠, sin evaluar a fondo):** Aider (CLI, licencia Apache-2.0), Goose, Amp, Cline CLI. Entrarían por ACP o adaptador simple.

### 2.8 Orquestación
* **Motor propio:** tablas `task`, `task_dependency`, `agent_run`; Scheduler que elige tareas listas (todas las dependencias *integradas/aprobadas*) y respeta presupuesto de recursos y concurrencia por proveedor.
* **LangGraph (JS):** potente para flujos con grafos y *checkpoints*; aquí duplicaría persistencia, añadiría dependencia y acoplaría el estado. Se reconsiderará solo si el coordinador necesita ciclos complejos con memoria. 🧠 sin verificación en esta sesión.
* **Coordinador:** un run de agente en modo *solo lectura* (`plan`/sandbox) que devuelve `Plan` (JSON validado por Zod). Sin permiso de escritura.

### 2.9 Android
RN + Expo Dev Build; navegación con Expo Router; `expo-secure-store` (Keystore); `expo-notifications` o canal propio. Módulo nativo del visor (futuro) con Expo Modules API (Kotlin). Alternativas y descartes en `01` §4.6.

### 2.10 Red
**Tailscale** (cliente oficial en Android/Windows; plan Personal gratuito según 🔎 terceros — verificar en `tailscale.com/pricing`). Core escucha en loopback + interfaz Tailscale (nunca 0.0.0.0 en interfaces públicas). **Alternativas:** *Headscale* (control plane autoalojado, sin cuenta de tercero, más mantenimiento), *WireGuard* directo (sin ACL cómodas), *Cloudflare Tunnel* (expone un endpoint público: **descartado** por el requisito de no exponer a Internet). Limitación: Android admite una VPN activa a la vez 🧠.

### 2.11 Control remoto — resumen de decisión
Ver `01` §5 y `09`. Criterios de decisión del PoC (pesos): sesión de consola real (obligatorio), entrada táctil y teclado utilizables (obligatorio), UAC/bloqueo (deseable alto), latencia p95 < 150 ms en WAN/VPN (deseable alto), consumo de red configurable, multi-monitor, posibilidad de integración, licencia.

## 3. Compatibilidades a vigilar

| Combinación | Riesgo | Mitigación |
|---|---|---|
| Electron ↔ módulos nativos | ABI | Nativos solo en Core |
| node-pty ↔ Windows | ConPTY ≥ 1809; PowerShell `SystemRoot` ✅ | Probar en PoC-5; fijar entorno |
| `.cmd` shims ↔ `spawn` sin shell | Falla/seguridad (🧠 CVE-2024-27980) | Resolver ejecutable real |
| Expo Go ↔ módulos nativos | No funciona 🔎 | Dev Build |
| Tailscale ↔ otra VPN en Android | Una VPN activa 🧠 | Documentar; Headscale no lo evita (sigue siendo VPN) |
| Claude SDK ↔ binario nativo opcional | Instalación sin optionalDeps ✅ | `pathToClaudeCodeExecutable` |
| Codex `app-server` ↔ versión CLI | `experimentalApi` ✅ | Fijar versión + contract tests |
| Sunshine ↔ códecs | Licencias de codificadores ✅ | Solo uso personal |
| AGPL/GPL ↔ distribución | Obligación de liberar fuente ✅ | No distribuir; o publicar |

## 4. Costos del stack
Todo el software del stack es gratuito/OSS (🧠 salvo verificar planes). Los costos variables: tokens/cuotas de proveedores de IA, hardware (RAM suficiente para N agentes + Chromium), eventualmente *dummy plug* para sesiones sin monitor, y tiempo de desarrollo. Detalle en `08`.
