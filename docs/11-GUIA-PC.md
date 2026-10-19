# 11 · Guía de pruebas en tu PC (Windows 11 Home) y móvil (S25 Ultra)

> Fecha: 2026-10-19. Objetivo: obtener **datos reales** para cerrar PoC-1…PoC-5 (`09`). Nada de esto lo he podido ejecutar yo:
> los comandos `winget` y los nombres de menús de RustDesk/Sunshine/Moonlight son de memoria y pueden diferir; si algo no coincide, apunta lo que ves y sigue.
> Duración estimada: 20 min (A+B) + 40–60 min (C). Se puede hacer por partes.

## A. Energía (5 min) — evita falsos fallos
1. Configuración → Sistema → Inicio/apagado y batería → "Pantalla y suspensión": en **conectado a la corriente**, suspender = **Nunca**.
2. Panel de control → Opciones de energía → "Elegir el comportamiento del cierre de la tapa" → **conectado: No hacer nada**.
3. Deja el portátil **enchufado**.

## B. PoC-5: terminal, procesos, SQLite, Git y agentes desacoplados en Windows
En PowerShell (como usuario normal; el paso 2 puede pedir administrador):
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# cierra y vuelve a abrir PowerShell
corepack enable
corepack prepare pnpm@10.0.0 --activate
git clone takedesk.bundle takedesk     # el archivo .bundle que te envié; ponlo antes en la carpeta actual
cd takedesk
git branch -a                          # debe existir claude/ai-workspace-feasibility-pn4jgg
git checkout claude/ai-workspace-feasibility-pn4jgg
pnpm install
pnpm check:boundaries
pnpm typecheck
pnpm test:win                          # subconjunto que debería pasar en Windows (el resto usa bash/sleep: NO ejecutes `pnpm test` completo)
pnpm poc                               # genera poc-report.md
```
- Es posible que **algún test de `test:win` falle por diferencias de Windows** (rutas con barras o nombres cortos 8.3, enlaces simbólicos, antivirus bloqueando archivos). Eso es información valiosa: copia el nombre del test y el mensaje.
- Si `pnpm install` falla al compilar `node-pty` o `better-sqlite3`, **copia el error completo**: es justo lo que queremos saber. Posible causa: faltan las *Visual Studio Build Tools* (carga de trabajo "Desarrollo de escritorio con C++").
- `pnpm poc` comprueba: edición de Windows, RAM/disco, si `git`, `claude`, `codex`, `opencode`, `agy` están en PATH y si son **shims `.cmd`**, terminal PowerShell con ConPTY, el error `8009001d`, matar un árbol de procesos sin huérfanos, SQLite en WAL con backup, worktrees (también con rutas > 260 caracteres) y el agente desacoplado (reenganche y cancelación).
- **Envíame el contenido de `poc-report.md`** y la salida de `pnpm test:win`.

## C. PoC-1…4: escritorio remoto
### C1. Red privada
1. PC: `winget install Tailscale.Tailscale` (o tailscale.com/download), inicia sesión.
2. Móvil: app Tailscale (Play Store), **misma cuenta**. Apunta la IP 100.x.y.z de la PC.
3. Prueba: en el móvil con **Wi-Fi apagado (datos móviles)**, la PC aparece "conectada" en la app. *(Android admite una sola VPN activa: desactiva otras.)*

### C2. Candidato 1: RustDesk
1. PC: `winget install RustDesk.RustDesk`; ábrelo y **instálalo como servicio** (botón "Instalar"/"Install", no solo ejecutar el portable). Móvil: RustDesk (Play Store).
2. Primera vuelta (solo funcional): conecta con el ID de la PC (usa sus servidores públicos de rendezvous). **Es solo para esta prueba**; la configuración segura (sin relays públicos, acceso solo por Tailscale) la hacemos después si gana.
3. Ejecuta los tests T1–T10 de abajo.

### C3. Candidato 2: Sunshine + Moonlight
1. PC: instalador de Windows desde https://github.com/LizardByte/Sunshine/releases . Abre su interfaz web (normalmente `https://localhost:47990`), crea usuario/contraseña.
2. Móvil: Moonlight (Play Store). Añade la PC por su **IP de Tailscale**; empareja con el PIN desde la pestaña "PIN" de Sunshine; elige la app **Desktop**.
3. Anota qué codificador usa (en Sunshine → Configuración → Video; NVENC = GTX 1650, QuickSync = Intel UHD). Repite T1–T10. Si la imagen sale negra, prueba cambiar de GPU/codificador (portátil híbrido) y anótalo.

### Tests (para cada candidato; marca OK / PARCIAL / NO + una nota)
| # | Qué hacer | Qué anotar |
|---|---|---|
| T1 | En la PC, desde PowerShell: `Start-Process chrome "https://example.com"`. Desde el móvil: verlo, hacer clic, escribir una URL | ¿Se ve Chrome abierto **fuera** de cualquier app tuya? ¿clic y escritura OK? |
| T2 | Abrir VS Code y el Explorador de archivos | ¿Se ven y se controlan? |
| T3 | Bloc de notas: escribir texto, Ctrl+C/Ctrl+V, Tab, Esc, Alt+Tab | ¿Qué teclas fallan? ¿el teclado del móvil es usable? |
| T4 | Móvil con **datos móviles** (Wi-Fi apagado) | ¿Conecta? ¿cuánto tarda? |
| T5 | Escribir 20 caracteres seguidos y mover el ratón | Latencia percibida 1–5 (1 = imperceptible) y FPS aproximados |
| T6 | **UAC:** en la PC `Start-Process notepad -Verb RunAs` | ¿Se ve el aviso en el móvil? ¿Puedes aceptarlo desde el móvil? ¿pantalla negra? |
| T7 | **Bloqueo:** Win+L | ¿Se ve la pantalla de bloqueo? ¿puedes escribir el PIN/contraseña desde el móvil? |
| T8 | **Tapa cerrada** (enchufado): cierra la tapa 30 s | ¿Sigue la conexión? ¿se ve imagen al reabrir? |
| T9 | Cortar Wi-Fi del móvil (pasar a datos) en plena sesión | ¿Se reconecta solo? ¿en cuántos segundos? |
| T10 | Durante 5 min de uso: Administrador de tareas → CPU/GPU %; en el móvil, consumo de datos de la app | % CPU/GPU del host y MB por 5 min |

### Qué me envías
Un mensaje compacto, por ejemplo:
```
Windows 11 Home build XXXXX. Android/One UI 9.
RustDesk: T1 OK, T2 OK, T3 PARCIAL (Alt+Tab no), T4 OK 6 s, T5 4/5, T6 NO (negro), T7 NO, T8 OK, T9 OK 8 s, T10 CPU 12 % / 90 MB
Sunshine+Moonlight (codificador NVENC): T1 OK, ...
Instalación: RustDesk 5 min, Sunshine 15 min (incidencias: ...)
```
Con eso cierro la decisión D-01 y decidimos si abordar el visor embebido (PoC-8).

## D. Seguridad mínima mientras pruebas
- No dejes RustDesk con contraseña permanente simple ni Sunshine accesible desde fuera de Tailscale; al terminar, desinstala el candidato que pierda o desactiva su servicio.
- No instales nada "portable" con permisos de administrador sin saber qué es.
