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
Script Node: lanzar Claude (SDK) y Codex (`exec --json`) en worktrees distintos con la misma tarea; normalizar eventos; cancelar a mitad; matar el proceso padre y comprobar reconciliación. Aceptación: CA-02, CA-11. Anotar qué campos reales emite cada versión (sustituye mis suposiciones 🔎).

### PoC-10 · Red privada y exposición
Android en datos móviles → Core por Tailscale; escaneo externo de la IP pública del hogar: ningún puerto abierto (CA-05, RNF-02). Medir latencia API y reconexión de WS.

---

## C. Cómo se registrarán los resultados
Plantilla por prueba en este archivo (sección D, a añadir): `ID · fecha · entorno · versión del software · procedimiento · datos medidos · veredicto (Cumple / Parcial / No cumple) · notas`. Un PoC "Cumple" solo con datos medidos y evidencia (capturas/logs), nunca por "se ve bien".

## D. Resultados de la Parte B
*(vacío — pendiente de ejecución)*
