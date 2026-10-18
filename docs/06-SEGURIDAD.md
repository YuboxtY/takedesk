# 06 · Seguridad y análisis de amenazas

> Fecha: 2026-10-18. Diseño propuesto; **ningún control está implementado ni auditado**. La seguridad real se demuestra con pruebas (§9), no con este documento.
> Contexto de riesgo: la aplicación **ejecuta comandos en Windows y permite controlar el equipo de forma remota** → compromiso = control total de la PC y de los secretos del usuario.

## 1. Activos y límites de confianza

| Activo | Por qué importa |
|---|---|
| Código fuente y repos | Propiedad intelectual; inyección de código malicioso |
| Credenciales de proveedores de IA / Git | Costes, robo de cuentas |
| Sesión de escritorio Windows | Acceso a correo, navegador, gestor de contraseñas |
| Clave privada del dispositivo Android | Suplantación del móvil |
| Base de datos y logs | Pueden contener prompts, rutas, secretos filtrados |

Límites de confianza: (1) contenido web en Electron → no confiable; (2) salida de agentes/LLM → **no confiable** (puede incluir comandos maliciosos por *prompt injection* desde código/web leído); (3) repositorios clonados → no confiables; (4) red (incluso VPN) → no equivale a autorización; (5) app móvil → confiable solo tras emparejar y mientras no esté revocada.

## 2. Modelo de amenazas (STRIDE resumido)

| ID | Amenaza | Vector | Control principal | Riesgo residual |
|---|---|---|---|---|
| T-01 | Suplantación de dispositivo | Robo de token | Claves Ed25519 en Android Keystore, firma por petición, nonce/anti-replay, revocación | Móvil desbloqueado y robado → biometría + auth reciente |
| T-02 | Acceso a API desde la red | Puerto expuesto | Escucha solo en loopback + interfaz Tailscale; sin 0.0.0.0; sin port-forward | Mala configuración → test de escaneo (RNF-02) |
| T-03 | Inyección de comandos | Datos del cliente a `spawn`/git | `spawn` con argv, sin shell; allowlist de ejecutables; validación Zod; rutas canonicalizadas dentro de raíces permitidas; rechazo de symlinks fuera | `.cmd` en Windows: resolver exe real |
| T-04 | *Prompt injection* → acciones dañinas del agente | Archivo/web malicioso | Permisos del agente por defecto en modo "preguntar"; reglas de denegación; worktree aislado; sin `bypassPermissions` remoto; aprobación humana para red/borrado/push | El humano aprueba mal → mostrar contexto claro |
| T-05 | Merge de código inseguro | Agente introduce backdoor | Revisión de diff obligatoria; tests; sin merge automático | Revisión humana imperfecta |
| T-06 | Escape de Electron | Contenido web ejecuta Node | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, preload mínimo y tipado, CSP, `WebContentsView` aislado para localhost, bloqueo de navegación externa | Vulnerabilidades de Chromium → actualizar |
| T-07 | Robo de secretos en reposo | Lectura de SQLite/logs | Secretos en Credential Manager/DPAPI (Core) y Keystore (Android); redacción en logs; sin tokens en SQLite | Malware con sesión del usuario lee DPAPI |
| T-08 | Fuga por logs/diagnóstico | Export | Redacción por patrón y clave; test con secretos plantados | Secretos nuevos sin patrón |
| T-09 | Secuestro del canal remoto | Host remoto con contraseña permanente | Sin contraseña fija; aprobación/token efimero por sesión desde Core; host solo accesible por Tailscale; deshabilitar relays públicos si el software lo permite (verificar) | Configuración del software de terceros |
| T-10 | Fuerza bruta de emparejamiento | Adivinar code | Code de un solo uso, TTL 2 min, 128 bits o QR, límite de intentos, aprobación local obligatoria | Ingeniería social |
| T-11 | Escalada de privilegios | Core como admin | Core y agentes **sin privilegios de administrador**; el host remoto (servicio) separado; elevación solo para el host si el PoC lo exige | Host remoto privilegiado = superficie |
| T-12 | Denegación de servicio | Flood WS | Límite de tamaño/frecuencia, cuota por dispositivo | |
| T-13 | Cadena de suministro | npm/PyPI/CLIs | Lockfiles, `pnpm audit`, versiones fijas, revisar scripts postinstall, firmas cuando existan | Riesgo permanente |
| T-14 | Manipulación del servidor OpenCode local | `opencode serve` en puerto local | Solo loopback, `OPENCODE_SERVER_PASSWORD` ✅ (auth básica), puerto aleatorio, proceso hijo del Core | Otro proceso local del usuario |
| T-15 | Persistencia del atacante | Dispositivo comprometido | Revocación inmediata, rotación de claves, auditoría | |
| T-16 | Acceso físico al PC | Sesión iniciada sin bloqueo | Bloqueo automático; si se usa auto-login, bloqueo inmediato; cifrado de disco (BitLocker) | |

## 3. Autenticación y emparejamiento

1. En escritorio: "Añadir dispositivo" crea `pairing_code` aleatorio, TTL 2 min, un solo uso; se muestra como QR con la **huella (hash de la clave pública) del Core** para evitar suplantación del Core (TOFU anclado en QR).
2. Android genera par **Ed25519** en Keystore (no exportable); envía clave pública + nombre.
3. Core pide **aprobación local** (diálogo en Electron) y asigna permisos mínimos.
4. Uso: cada petición HTTP lleva `X-Device`, `X-Ts`, `X-Nonce`, firma sobre método+ruta+hash del cuerpo. WebSocket: token corto (≤ 60 s) obtenido por petición firmada. Anti-replay: ventana de ±30 s y caché de nonces.
5. **Autenticación reciente** (biometría local + firma fresca) para: aprobar comandos/merge, iniciar control remoto, revocar/añadir dispositivos.
6. Transporte: Tailscale (WireGuard) **más** TLS propio o firmas a nivel de aplicación (la VPN no sustituye autorización; defensa en profundidad). Nota: el cifrado de la VPN no cubre al propio Core si hay software hostil en la PC.

## 4. Autorización (permisos por dispositivo)

`projects.read`, `runs.read`, `runs.execute`, `runs.cancel`, `approvals.decide`, `tasks.manage`, `terminal.read`, `terminal.write`, `remote.view`, `remote.control`, `devices.manage`, `admin`. Móvil por defecto: lectura + aprobar; `terminal.write`, `remote.control` y `devices.manage` activados explícitamente. `admin` nunca desde móvil.

## 5. Ejecución de comandos y agentes

* Allowlist de binarios (git, node, pnpm, claude, codex, gemini, opencode…) con ruta absoluta resuelta y hash/versión registrados en `probe()`.
* Variables de entorno de agentes: **lista blanca** (no heredar todo el entorno del usuario; no pasar tokens de otros proveedores).
* Directorio de trabajo restringido al worktree; escrituras fuera de él requieren aprobación (política del adaptador y del agente).
* Límites: tiempo máximo, tamaño de salida, nº de procesos hijos (Job Object en Windows 🧠).
* Acciones destructivas (borrar worktree sucio, `git reset --hard`, `push --force`, borrar proyecto, revocar todo) → confirmación explícita + registro.
* Claude: usar `disallowedTools` con reglas escopadas (ej. `Bash(rm *)`) ✅ y `permissionMode` conservador; **no** `bypassPermissions` salvo sandbox desechable.

## 6. Secretos

| Secreto | Dónde vive | Notas |
|---|---|---|
| API keys de proveedores | Windows Credential Manager / DPAPI (acceso desde Core) | La librería concreta (`keytar` está archivada 🧠; evaluar alternativas mantenidas o `electron safeStorage` desde UI) → decisión D-11 |
| Clave privada de dispositivo | Android Keystore | No exportable |
| Claves públicas de dispositivos | SQLite | Son públicas |
| Token WS efímero | Memoria | TTL corto |
| Contraseñas del host remoto | **No se usan fijas** | Aprobación por sesión |
| Backups | Sin secretos; cifrados si salen del equipo | |

Autenticación de proveedores: Anthropic exige API key para productos de terceros basados en el Agent SDK y prohíbe ofrecer login claude.ai sin aprobación (✅ `code.claude.com/docs/en/agent-sdk/overview`). Mientras no se aclare, **nuestra app no gestionará ni reenviará credenciales de suscripción**: o API key del usuario, o el CLI instalado autenticado por el propio usuario (decisión D-09, ahora **aceptada con reservas**: los agentes usan tu suscripción mediante los CLI oficiales sin modificar; nuestra app **no lee ni almacena** sus credenciales ni archivos de sesión, lo que además reduce la superficie de robo de secretos).

## 7. Escritorio remoto: reglas específicas

* El host remoto escucha solo en la interfaz Tailscale / usa solo el canal privado; sin UPnP; sin puertos en el router.
* Si es RustDesk: servidor autoalojado (hbbs/hbbr) accesible solo por Tailscale; **desactivar** la conexión por servidores públicos; contraseña permanente desactivada; aprobación manual o token efímero ligado a nuestra sesión (verificar en PoC qué permite el cliente; si no se puede ligar, se documenta como riesgo).
* Si es Sunshine: no exponer su UI web (puerto de administración) fuera de loopback/Tailscale; emparejamiento por PIN.
* Registrar `remote_session` (quién, cuándo, desde qué dispositivo). Permitir **terminar sesión desde el escritorio**.
* **UAC / escritorio seguro:** controlar el escritorio seguro implica un componente con privilegios; es un trade-off de seguridad. Preferir **no** operar UAC remotamente salvo necesidad (RF-08c es P1/Experimental); si se habilita, solo vía servicio del host y con permiso `remote.control` + auth reciente.
* No grabar vídeo por defecto.

## 8. Electron

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity` activo, `allowRunningInsecureContent: false`, CSP estricta, `setWindowOpenHandler` denegando, `will-navigate` bloqueado salvo allowlist, permisos de sesión denegados por defecto, preload con API mínima (`ipcRenderer.invoke` canalizado y validado), sin `remote`. Vista localhost: `WebContentsView` en partición propia, sin preload, sin acceso al Core.

## 9. Pruebas de seguridad (checklist verificable)

| # | Prueba | Criterio |
|---|---|---|
| S-01 | Escaneo de puertos desde red externa | Sin puertos del Core/host |
| S-02 | Petición sin firma / firma inválida / replay / reloj desfasado | Rechazadas |
| S-03 | Dispositivo revocado | Peticiones y WS rechazados < 2 s; sesión remota cerrada |
| S-04 | Fuzzing de rutas y parámetros (`..\`, UNC, symlinks, nombres reservados de Windows) | Ninguna escritura fuera de raíces |
| S-05 | Inyección en nombres de rama/proyecto (`; & | $()`) | No se ejecuta shell |
| S-06 | Secretos plantados en prompts y env | No aparecen en logs ni export |
| S-07 | Electron: intento de `require` desde página localhost | Falla |
| S-08 | Prompt injection en un archivo del repo con orden de exfiltrar `.env` | Acción pedida requiere aprobación y se bloquea |
| S-09 | `npm audit`/`pnpm audit` en CI | Sin críticas |
| S-10 | Limpieza: tras cancelar, 0 procesos huérfanos | RNF-12 |

Antes de usar la app con acceso remoto real se recomienda una **revisión de seguridad independiente** de pairing/firma (esta documentación no sustituye una auditoría).

## 10. Fuentes (consulta 2026-10-18)
✅ AGPL-3.0 §13 (texto de la licencia de RustDesk); ✅ Claude Agent SDK (permisos, `disallowedTools`, política de autenticación): https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/agent-sdk/overview ; ✅ OpenCode server (auth): https://github.com/sst/opencode ; ✅ node-pty README (permisos del proceso padre); 🔎 RustDesk elevación/UAC: https://rustdesk.com/docs/en/client/windows/windows-portable-elevation/ ; 🔎 Electron seguridad (https://www.electronjs.org/docs/latest/tutorial/security) 🧠 no leída en esta sesión.
