# 12 · El lienzo (cómo se usa y qué garantiza)

> Referencia de producto: Deska (lienzo infinito y ampliable donde editores, terminales, navegadores y asistentes de IA conviven; un espacio por proyecto; todo local). Arranque: `pnpm desktop`.

## Qué hay
| Función | Cómo |
|---|---|
| **Lienzo infinito** | Ctrl+rueda / pellizco = zoom en el cursor (10 %–300 %); rueda o arrastrar el fondo = desplazar; botón central desde cualquier sitio; HUD abajo (− % + Ajustar); `Ctrl+Alt+ +/−`, `Ctrl+Alt+0` (100 %), `Ctrl+Alt+F` (ver todo) |
| **Espacios** | Pestañas superiores, cada una con sus paneles, su cámara y su fondo; `Ctrl+Shift+S` crea, `Ctrl+Alt+1…9` / `←→` cambian, doble clic renombra, cerrar pide confirmar |
| **Paneles** | Terminal · Agente (uno por modelo: Claude Code, OpenCode…) · Revisión de cambios (diff + fusionar) · Editor (Monaco + explorador) · Navegador (pestañas) · Notas · Apps · sesiones CLI interactivas (`claude`, `opencode`) en su propio terminal |
| **Fondos y tema** | 🎨 Fondo: puntos, cuadrícula, líneas, liso, degradados, imagen propia + color y oscurecimiento (por espacio); tema Sistema/Oscuro/Claro |
| **Atajos** | F1 los muestra: `Ctrl+Shift+T/A/N/B/E/W/S` y `Ctrl+Alt+…` (se evita Ctrl+letra suelto para no chocar con terminales y editores) |
| **Apps del equipo** | Panel Apps: VS Code, Explorador, Terminal de Windows, PowerShell, Bloc de notas, abiertos en la carpeta del proyecto |

## Lo que NO hace (y por qué)
* **No incrusta ventanas de apps nativas** (Chrome, Office…) dentro del lienzo: Windows no ofrece una forma segura y estable de hacerlo desde una app Electron. Se resuelve con terminal, editor y navegador **integrados** y un lanzador para el resto. Capturar y controlar ventanas nativas sería otro proyecto (y está pendiente del acceso remoto, PoC-1…4).
* Sin descargas ni permisos de cámara/micrófono/ubicación en el navegador integrado (se pueden abrir fuera con ↗).
* El editor corre sin workers de lenguaje (sin IntelliSense avanzado de TypeScript/JSON).

## Modelo de seguridad (resumen)
* La interfaz **nunca ve el token del Core**: el proceso principal añade la cabecera y solo permite una lista blanca de rutas.
* **Archivos:** solo rutas relativas dentro de un proyecto registrado; se resuelven con rutas reales (rechaza `..`, rutas absolutas, UNC, enlaces/junctions hacia fuera y escrituras en `.git`); 2 MB; sin binarios; detección de conflictos.
* **Navegador:** `<webview>` con perfil propio, sin Node, sandbox, solo `http`/`https`; ventanas nuevas → pestañas; sin descargas ni permisos.
* **Imágenes de fondo:** validadas por firma real, ≤ 8 MB, copiadas a una carpeta propia y referenciadas por nombre generado (nunca por ruta).
* **Apps:** lista cerrada de ejecutables y argumentos fijos; solo varía la raíz del proyecto.
* **Fusión de agentes:** exige el commit exacto que se revisó; un conflicto no pierde trabajo.
* Todo el workspace guardado (paneles, espacios, cámara, fondos, tema) se sanea antes de escribirse.

## Verificación
`node apps/desktop/scripts/e2e.mjs` (Electron real + CDP, datos aislados): **79 comprobaciones**. `pnpm test:win`: 141+ pruebas. `node apps/desktop/scripts/e2e-claude.mjs` (requiere sesión de Claude): panel de agente real y CLI interactivo. Detalle y límites de cada etapa: `docs/09`, sección D.
