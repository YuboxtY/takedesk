# 10 · Decisiones técnicas (ADR)

> Fecha: 2026-10-18. Estado: **Propuesta** (pendiente de tu aprobación) salvo indicación. Formato: contexto → decisión → alternativas → consecuencias.

| ID | Decisión | Estado |
|---|---|---|
| D-01 | Host de escritorio remoto: RustDesk (MVP, externo) → Moonlight/Sunshine si se integra | Provisional — decide PoC-2 |
| D-02 | Visor remoto: cliente externo en MVP; embebido condicionado a PoC-8 | Propuesta |
| D-03 | Core = proceso de usuario supervisado, no servicio Session 0 | Propuesta (fuerte) |
| D-04 | node-pty y SQLite viven en el Core | Propuesta (fuerte) |
| D-05 | Adaptadores nativos (Claude, Codex) + ACP genérico (Gemini, OpenCode, otros) | Propuesta |
| D-06 | Orquestador propio mínimo; coordinador emite plan validado | Propuesta |
| D-07 | Android: React Native + Expo Dev Build | Propuesta |
| D-08 | Red privada: Tailscale + emparejamiento propio firmado | Propuesta |
| D-09 | Autenticación: suscripción del usuario mediante los CLIs oficiales sin modificar; la app nunca toca tokens | **Aceptada con reservas** (ver abajo) |
| D-10 | Logs/salidas en NDJSON rotado; SQLite solo índice y metadatos | Propuesta |
| D-11 | Almacén de secretos en Windows (librería a elegir) | Pendiente de evaluación |
| D-12 | Contratos con Zod en `packages/contracts` | Propuesta |
| D-13 | Monorepo pnpm; Turborepo diferido | Propuesta |
| D-14 | Merge siempre manual; integración secuencial | Propuesta (fuerte, del documento) |
| D-16 | Planificación por cuotas de suscripción (pool por proveedor) | Propuesta |
| D-15 | Presupuesto de disco/RAM por defecto para el hardware del usuario | Propuesta |

---

## D-01 · Host de escritorio remoto
* **Contexto:** hay que ver/controlar la sesión de consola real (Chrome abierto por un agente). Necesidad de integrar con nuestra app y operación sin exponer puertos.
* **Opciones:**
  1. **RustDesk** (AGPL-3.0 ✅; cliente Android Flutter; arquitectura rendezvous/relay autoalojable ✅). *Pro:* experiencia de "escritorio remoto" completa (clipboard, archivos, multi-monitor, modos táctiles), servidor propio. *Contra:* sin SDK embebible oficial localizado; integración = app externa o fork Flutter/Rust; UAC solo documentado para portable (🔎).
  2. **Sunshine + Moonlight** (GPL-3.0 ✅). *Pro:* streaming de baja latencia; cliente Android nativo reutilizable; capturas por servicio SYSTEM ✅. *Contra:* orientado a juegos (UX de escritorio/teclado menos pulida), emparejamiento por PIN, codificación depende de GPU/CPU, docs no cubren UAC/bloqueo ✅(ausencia).
  3. **RDP/FreeRDP:** sesión distinta de la consola → no cumple el caso de uso (🔎/🧠); Home no es host (🔎).
  4. **WebRTC propio:** coste y riesgo de seguridad altos; descartado para MVP.
  5. **VNC:** viable pero experiencia/seguridad inferiores; fallback.
* **Decisión provisional:** RustDesk como cliente externo para el MVP por rapidez de PoC y mejor UX de escritorio; **mantener la interfaz `RemoteHost` abstracta** para poder pasar a Moonlight/Sunshine. **Cambiaría la decisión** si PoC-2 muestra: latencia p95 > 150 ms con RustDesk y < con Moonlight; imposibilidad de limitar a canal privado; o fallo de entrada táctil.
* **Consecuencias:** AGPL: no distribuir fork; usar sin modificar evita obligaciones. El usuario confirmó (2026-10-18) uso solo personal, por lo que un fork privado también es viable sin obligaciones prácticas (no es asesoramiento legal).
* **Hardware del usuario:** GPU híbrida GTX 1650 + UHD 630 en portátil: probar codificadores por separado (PoC-2b) y tapa cerrada (PoC-3b).

## D-02 · Visor externo vs embebido
* **Decisión:** MVP con cliente externo (intent) + estado del host en nuestra app. Embebido solo tras PoC-8 y aprobación expresa del usuario (implicaciones de copyleft y mantenimiento).
* **Alternativas:** embebido desde el inicio (riesgo: bloquea el proyecto); WebView/PWA (no hay decodificador soportado).
* **Consecuencias:** UX de dos apps en el MVP (aceptado por el documento original: "external-client fallback").

## D-03 · Core como proceso de usuario
* **Contexto:** los agentes deben abrir apps visibles; servicios corren en Session 0 aislada (🔎).
* **Decisión:** Tarea Programada "al iniciar sesión" + supervisor. **Alternativa descartada:** servicio Windows con helper en sesión de usuario (más complejidad, sin necesidad hoy).
* **Consecuencias:** cerrar sesión de Windows mata agentes (documentado); bloquear no.

## D-04 · PTY y BD en el Core
* **Contexto:** CA-03 + ABI de Electron. **Decisión:** ambos en Core (Node puro). **Consecuencia:** Electron es cliente fino; `@electron/rebuild` innecesario.

## D-05 · Estrategia de adaptadores
* **Contexto:** capacidades heterogéneas (`01` §4.2).
* **Decisión:** interfaz común con `capabilities`. Claude → `claude-cli` (binario oficial sin modificar con tu sesión; ver D-09) y Agent SDK ✅ solo con API key; Codex → `exec --json` primero, `app-server` si hacen falta aprobaciones/hilos (parte `experimentalApi` ✅); Antigravity → `agy` headless stream-json 🔎 (sin ACP nativo); Gemini CLI → `--acp` ✅ (opcional, no instalado); OpenCode → servidor HTTP+SDK ✅ (o ACP); `generic-pty` como último recurso.
* **Alternativa:** solo ACP (más simple; menos funciones y dependencia de adaptadores de terceros 🔎) o solo PTY (frágil).
* **Consecuencias:** más código inicial, pero cambios de un proveedor no afectan al resto.

**Orden de implementación de adaptadores (según lo instalado):** 1) Claude, 2) Codex, 3) OpenCode (API HTTP documentada, la más sencilla de verificar), 4) Antigravity.

## D-09 (actualizada 2026-10-18) · Suscripción en los cuatro agentes
* **Hechos leídos en la fuente primaria** (`code.claude.com/docs/en/legal-and-compliance`): el OAuth de suscripción es para "uso ordinario de Claude Code y otras aplicaciones nativas de Anthropic"; los desarrolladores que construyan productos, **incluido con el Agent SDK, deben usar API key**; Anthropic no permite ofrecer login de Claude.ai ni enrutar peticiones con credenciales de plan Free/Pro/Max, ni "recolectar, almacenar o intermediar" credenciales o tokens de sesión; **sí permite que un usuario inicie sesión con su suscripción en el binario de Claude Code sin modificar**; el binario no debe modificarse; Anthropic puede aplicar restricciones **sin previo aviso**. Fuentes secundarias (🔎) cuentan que desde 2026 se bloquearon herramientas de terceros (incluido OpenCode) que usaban el OAuth de Claude y que el uso del OAuth con el Agent SDK se trata como incumplimiento; **no lo verifiqué en una fuente de Anthropic**.
* **Decisión (para Claude):** adaptador `claude-cli` que ejecuta **el binario oficial `claude` sin modificar, ya autenticado por ti**, en modo no interactivo (`-p`, `stream-json`). La app **nunca lee, copia ni reenvía** tokens ni el archivo de credenciales. El adaptador con el Agent SDK queda **solo para API key**. Es la lectura más conservadora de las reglas, no una garantía: la frontera entre "herramienta personal" y "producto" no está definida con claridad para tu caso, y el riesgo de una restricción de la cuenta es tuyo. Si quieres certeza total, la única vía inequívoca es usar API key para Claude.
* **OpenCode:** no usarlo con el OAuth de Claude (🔎 reportado como bloqueado). Dime con qué proveedor lo usas.
* **Codex:** el inicio de sesión con ChatGPT es la vía recomendada en su documentación (🔎 espejo de la documentación de OpenAI); los términos sobre automatización no los verifiqué. Para ejecución desatendida, algunas fuentes recomiendan API key.
* **Antigravity:** es el CLI de Google que sustituye a Gemini CLI (🔎 una fuente indica que Gemini CLI dejó de servir cuentas Pro/Ultra el 18-jun-2026); su modo headless está documentado (🔎). Usa modelos Gemini; las cuentas Ultra aparecen con acceso a modelos de terceros y las fuentes discrepan sobre cuáles (probar con tu plan). Términos de uso automatizado sin verificar.
* **Reglas para todos los adaptadores:** el entorno de los procesos hijos debe conservar lo que cada CLI necesita para encontrar *su propio* inicio de sesión (perfil de usuario/`APPDATA`), pero la app no accede a esos archivos; sin pasar tokens de un proveedor a otro.
* **Consecuencia práctica:** con suscripciones, el límite no es dinero por token sino **cuota** (ventanas de 5 h y límites semanales, 🔎). Ver D-16.

## D-16 · Planificación por cuotas de suscripción
* **Contexto:** varios agentes en paralelo gastan **la misma cuota** de tu plan; Google habla de cuotas cada 5 h y semanales y de que el consumo depende del trabajo del agente (🔎); Anthropic indica que los límites de Pro/Max suponen uso "ordinario e individual" ✅.
* **Decisión:** cada proveedor es un *pool* con concurrencia máxima propia (inicial **2** por proveedor y **3** en total), detección de límites (mensajes de límite/429, y eventos de límite cuando el CLI los emita) y **pausa automática** del pool al agotarse, con aviso. El coordinador debe preferir pocos agentes bien dirigidos a muchos.
* **Alternativa:** ignorar cuotas (riesgo de quedarte sin cuota a mitad de plan y de que el planificador reintente en bucle).
* **Consecuencia:** el orquestador (Etapa 6) planifica con "presupuesto de cuota" estimado, no en dólares.

## D-06 · Orquestación
* **Decisión:** motor propio (DAG + scheduler + FSM persistidos en SQLite). LangGraph se reevaluará solo si aparecen flujos cíclicos complejos con memoria. El coordinador **no** escribe código ni ejecuta: devuelve `Plan` validado. 
* **Consecuencias:** control total y sin dependencia nueva; coste: implementar scheduler y pruebas.

## D-07 · Android
* **Decisión:** React Native + Expo Dev Build (módulos nativos futuros con Expo Modules API). **Alternativas:** Kotlin nativo (mejor para visor; pierde contratos TS), Flutter (natural si se forkea RustDesk), PWA (solo respaldo).
* **Cambio de decisión si:** D-01/D-02 llevan a forkear el cliente Flutter de RustDesk → reevaluar Flutter para toda la app.

## D-08 · Red
* **Decisión:** Tailscale + firma por dispositivo. **Alternativas:** Headscale (autoalojado, más mantenimiento), WireGuard, Cloudflare Tunnel (descartado: endpoint público).

## D-09 · Autenticación con proveedores (requiere tu respuesta)
* **Hechos:** Anthropic: productos de terceros sobre Agent SDK → API key; no se permite ofrecer login/limites de claude.ai sin aprobación previa ✅; marca "Claude Code" no permitida en productos derivados ✅. Para Codex/Gemini/OpenCode no verifiqué términos equivalentes.
* **Opciones:** (a) API keys del usuario guardadas en almacén seguro (más claro, coste por token); (b) usar el CLI ya autenticado del usuario con su suscripción (más barato, **zona gris** al orquestarlo desde nuestra app; leer términos vigentes); (c) mezclar según proveedor.
* **Instalados por el usuario (2026-10-18):** Claude Code, Codex, OpenCode, Antigravity. Falta el método de autenticación de cada uno. Para Antigravity tampoco verifiqué términos.
* **Recomendación:** (a) por defecto; (b) solo tras revisar términos de cada proveedor. **Necesito tu elección.**

## D-10 · Logs fuera de la BD
* **Decisión:** eventos completos en NDJSON por run (comprimido al cerrar), índice en SQLite, retención por tiempo/tamaño, truncado de eventos voluminosos. **Alternativa:** todo en SQLite (más simple; crecimiento y VACUUM costosos).

## D-11 · Almacén de secretos
* **Contexto:** Core no es Electron (no `safeStorage` directo). `keytar` fue archivado (🧠). Opciones: binding de Credential Manager mantenido, DPAPI vía módulo nativo, o que Electron cifre y entregue al Core. **Pendiente:** evaluación en Etapa 1 con criterios de mantenimiento y soporte de Windows.

## D-12 / D-13 / D-14
* **Zod como fuente de verdad** (tipos + validación en frontera + exportación de esquema). Alternativa: OpenAPI-first (más burocracia).
* **pnpm workspaces** sin Turborepo hasta que el tiempo de CI lo justifique.
* **Merge manual:** cualquier automatización de merge queda fuera de alcance (riesgo de código inseguro/semántico).

---

## D-15 · Presupuestos por defecto para el equipo del usuario
* **Contexto:** portátil con 16 GB de RAM y ~63 GB de disco libre (`08` §6).
* **Decisión:** máx. 3 runs simultáneos; reserva de 3 GB de RAM; no iniciar runs con < 15 GB de disco libre; cuota de worktrees 15 GB; retención corta; pnpm con store en la misma unidad. Todos configurables.
* **Alternativas:** sin límites (riesgo de llenar el disco y bloquear Windows); límites mucho más conservadores (1–2 agentes; subutiliza el producto).
* **Consecuencias:** los valores son hipótesis y se ajustan con PoC-6/PoC-6b.

## Decisiones que se revisarán con datos
| Decisión | Se revisa tras | Condición de cambio |
|---|---|---|
| D-01 | PoC-1…4 | Ver criterios en D-01 |
| D-02 | PoC-8 | Esfuerzo > 8 semanas o licencia inaceptable |
| D-05 | PoC-9 | Si ACP cubre las capacidades de Claude/Codex sin pérdida |
| D-07 | D-01/D-02 | Si se elige fork de RustDesk |
