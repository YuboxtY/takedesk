# 08 · Riesgos, limitaciones y costos

> Fecha: 2026-10-18. Probabilidad (P) e Impacto (I): B/M/A. Puntuación = juicio mío, no medición.

## 1. Registro de riesgos

| ID | Riesgo | P | I | Mitigación | Disparador / prueba |
|---|---|---|---|---|---|
| R-01 | El host remoto no captura UAC/bloqueo/login | A | M | Aceptar límite; solo servicio del host; documentar en UI "PC bloqueada" | PoC-3 |
| R-02 | Visor embebido inviable o demasiado costoso | M | M | Mantener cliente externo (ruta A) como objetivo del MVP | PoC-8 |
| R-03 | Copyleft (AGPL/GPL) condiciona distribución | M | M | Uso personal; si se distribuye, publicar código; procesos externos separados | Decisión legal del usuario |
| R-04 | Sin monitor físico, Windows reduce o desactiva la salida gráfica | M | A | Dummy plug HDMI / controlador de pantalla virtual | PoC-3 |
| R-05 | Core no puede ser servicio → muere al cerrar sesión | A | M | Aceptar y documentar; mantener sesión bloqueada, no cerrada | CA-03/11 |
| R-06 | Cambios de formato/protocolo en CLIs rompen adaptadores | A | M | Contract tests, versión fija, estado `degraded`, ACP como respaldo | CI nocturno |
| R-07 | Aprobación interactiva no disponible en algún proveedor | A | M | Capabilities; usar modos de sandbox; no ofrecer lo que no existe | CA-12 |
| R-08 | Restricciones de autenticación/ToS de proveedores (p. ej. suscripción Claude con Agent SDK) | M | A | API keys, uso del CLI propio del usuario, revisar términos vigentes | Antes de Etapa 2 |
| R-09 | Cuotas/429 y costes inesperados | A | M | Presupuestos por plan/run, semáforos por proveedor, alertas | Etapa 6 |
| R-10 | RAM/CPU insuficientes para N agentes + Chromium + host remoto | M | M | Scheduler por recursos; medir | PoC-6 |
| R-11 | Compilación nativa en Windows (node-pty, better-sqlite3) falla | M | M | Prebuilds, toolchain documentada, CI Windows | Etapa 1 |
| R-12 | Árbol de procesos no se mata en Windows → huérfanos | M | A | Job Objects / `taskkill /T`, prueba automática | RNF-12 |
| R-13 | Corrupción o crecimiento de SQLite/logs | B | A | WAL, único escritor, `quick_check`, NDJSON rotado, retención, backups probados | PoC-7 |
| R-14 | Prompt injection provoca acciones dañinas | M | A | Permisos por defecto, aislamiento, aprobación, denegaciones | S-08 |
| R-15 | Comprometer el móvil = control de la PC | B | A | Keystore, biometría, permisos mínimos, revocación, auth reciente | S-01…S-03 |
| R-16 | Android mata el servicio en segundo plano / ahorro de batería | A | M | Foreground service solo si necesario; push; reconexión idempotente | Etapa 4 |
| R-17 | Tailscale: dependencia de tercero / una sola VPN en Android | M | M | Headscale/WireGuard como alternativa; documentar | CA-05 |
| R-18 | Dependencia de un solo mantenedor (RustDesk, Sunshine…) | M | M | Aislar tras interfaz `RemoteHost`; poder cambiar | |
| R-19 | Alcance excesivo (sobreingeniería) | A | A | Etapas con puertas; MVP recortado; ADRs; "no construir lo no validado" | Revisiones por etapa |
| R-20 | Conflictos semánticos tras merges | M | M | Merge secuencial + tests por merge | Etapa 3 |
| R-21 | Fugas de memoria en Core/Electron (streams, WS, xterm) | M | M | Límite de buffers, métricas, soak 72 h | RNF-11 |
| R-22 | Actualizaciones de Electron/Expo rompen build | M | M | Versiones fijas, actualizar en ventanas con suite completa | |
| R-23 | Energía: PC se suspende durante runs | M | M | Ajustes de energía, `powercfg`, solicitar "keep awake" mientras hay runs | Etapa 1 |
| R-24 | Wake-on-LAN no accesible por Internet | A | B | Opcional; no prometerlo | |

## 2. Limitaciones conocidas (explícitas)

* No se puede ver/controlar la PC **apagada o suspendida**; no se garantiza con Windows **cerrado de sesión**.
* **RDP nativo** no sirve como solución principal para ver lo que abren los agentes (sesión distinta) ni en Windows Home (🔎).
* Las salidas de los CLIs **no son una API estable**; solo los modos estructurados documentados (stream-json, JSONL, ACP, HTTP) lo son parcialmente.
* La reanudación **no restaura contexto idéntico** (p. ej. `--append-system-prompt` no se reaplica al reanudar según fuente secundaria 🔎; verificar).
* Pruebas *headless* no producen ventana visible; para verlas hay que ejecutar en modo *headed*.
* No existe en esta sesión **ninguna prueba en Windows/Android**; las afirmaciones de esas plataformas son documentales.
* "Funcionar durante años" no se promete: se proponen mecanismos (backups probados, migraciones, soak tests, diagnósticos) para detectar y corregir degradación.

## 3. Obstáculos legales / de licencia (resumen)

| Pieza | Licencia | Implicación para este proyecto |
|---|---|---|
| RustDesk (cliente/servidor OSS) | ✅ AGPL-3.0; servidor Pro propietario 🔎 | Embeber/forkear = obra derivada; sin distribución no hay obligación práctica; con distribución, publicar fuente. Preferir uso como app externa. |
| Sunshine | ✅ GPL-3.0; ✅ sin derechos sobre codificadores | Uso personal OK; redistribuir comercialmente exige licencias de códec |
| moonlight-android | ✅ GPL-3.0 | Igual que arriba |
| FreeRDP | ✅ Apache-2.0 | Embebible sin copyleft (pero no resuelve la sesión) |
| OpenCode | ✅ MIT | Sin restricciones relevantes |
| node-pty | ✅ MIT | |
| Claude Agent SDK | Términos comerciales de Anthropic ✅ | No usar marca "Claude Code"; auth con API key para productos |
| Codex CLI / Gemini CLI | 🧠 Apache-2.0 (confirmar) | |
| Tailscale | Servicio comercial con plan gratuito 🔎 | Términos del plan |

*Esto no es asesoramiento legal.*

## 4. Costos

### 4.1 Desarrollo
Tiempo: ver `07` (MVP ~13–19 semanas; completo ~5–8 meses; estimaciones). Si se contrata o se valora el tiempo, es el costo dominante. El gasto en **modelos durante el desarrollo** (agentes que ayudan a construir) también cuenta.

### 4.2 Operación (mensual aproximado, sujeto a verificar precios vigentes)
| Concepto | Costo | Evidencia |
|---|---|---|
| Software base (Electron, Node, SQLite, RN, xterm, Monaco…) | 0 | OSS |
| RustDesk autoalojado / Sunshine+Moonlight | 0 | OSS ✅ |
| Tailscale Personal | 0 según fuente secundaria (6 usuarios, dispositivos ilimitados en uso personal) | 🔎 verificar en tailscale.com/pricing |
| Distribución Android | 0 si APK propio (sin Google Play) | 🧠 |
| Compilaciones Expo | Local gratis; EAS tiene planes 🧠 | |
| **Modelos de IA** | **Variable: lo mayor.** API por tokens o cuota de suscripción; ejecutar N agentes multiplica el consumo; el coordinador añade llamadas | Precios no verificados aquí |
| Hardware | Posible RAM extra; *dummy plug* HDMI (decenas de USD 🧠); GPU con codificador por hardware mejora Sunshine | 🧠 |
| Firma de código (Windows) | Opcional para uso personal | 🧠 |

### 4.3 Control de costos incorporado en el diseño
Presupuesto por plan/run (tokens, tiempo, intentos), alertas al 80 %, pausa al exceder, registro de uso por proveedor (cuando el CLI lo informe), límite diario configurable.

## 5. Qué simplificar sin perder el núcleo
1. Cliente remoto externo antes que embebido.
2. Un host (Windows) y un cliente (Android).
3. Paneles fijos antes que lienzo libre.
4. Agentes manuales antes que coordinador.
5. Dos adaptadores completos antes que cuatro.
6. Sin voz, sin Wake-on-LAN, sin multiusuario.
