# 13 · Plan por fases: acercar el lienzo a Deska (y a "todas mis apps con IA")

> Fecha: 2026-10-19. Objetivo del usuario: una pantalla infinita para abrir **muchas apps** (Notion, editores, navegadores, terminales, agentes de IA…) que **funcionen de verdad** (guardan sus datos), con la **UI de Deska**, con fondos de **imágenes propias** y sin que el tema claro cambie el aspecto de las apps.

## Lo que se sabe de Deska (fuentes públicas)
Fuente: [deska.dev](https://www.deska.dev) y el índice de su documentación. **No publica su stack** (ni Electron/Tauri ni frameworks); cualquier afirmación sobre cómo está hecho sería una suposición. Lo observable:
* App de escritorio (Mac/Windows/Linux) + versión web; **lienzo infinito y ampliable**, "todo es un panel", un **workspace por proyecto**, **Spaces** y **Tools** en los laterales, barra superior con migas (equipo › proyecto › rama) y estado de tareas, **dock inferior** ("Añadir panel", herramientas, asistente Dex, Inbox), HUD de zoom (− 100 % +) y de uso de cuota, **fondos con imagen** y temas claro/oscuro.
* Paneles: terminal, código, Git y archivos, **navegador y widgets**, notas/cuaderno; **paneles de la comunidad y Marketplace** (hay un SDK con `panel.json`, "sandbox", "theme tokens" y "acciones de panel": los paneles de terceros parecen ser web aisladas).
* IA: agentes de código (Claude Code, Codex, OpenCode, Cursor, Antigravity, Kimi…) como **tareas con worktree propio** y **Inbox** de permisos; **hilos** por agente; **Dex** (voz) que enruta a los agentes; `Ctrl/Cmd+K` paleta de comandos, `Ctrl/Cmd+L` preguntar a Dex.
* Acceso remoto al equipo desde el móvil/web (de pago), notificaciones, atajos reasignables, local-first.
* **No** se observa que incruste ventanas de aplicaciones nativas arbitrarias: su "navegador" y sus "widgets" son web.

## Decisión de alcance sobre "las apps de la PC dentro del lienzo"
| Tipo de app | Se puede | Cómo | Riesgo |
|---|---|---|---|
| **Apps web** (Notion, Gmail, Docs, Figma, Linear, Slack, GitHub…) | **Sí, funcionales y con tus datos** | Panel web con **perfil persistente por app** (sesión, cookies, almacenamiento), permisos por sitio, descargas con confirmación | Google bloquea el inicio de sesión en navegadores embebidos (usa otro método de acceso o abre fuera para iniciar sesión); sin instalar la app de escritorio |
| **Terminal, editor, Git, notas, agentes** | Sí (ya hecho en gran parte) | Paneles propios | — |
| **Apps nativas de Windows** (Notion de escritorio, Word, Photoshop…) | **Parcial y experimental** | (a) Reparentar su ventana (`SetParent`) dentro del panel: funciona con algunas apps Win32, falla o se comporta mal con muchas (Chromium/Electron, UWP); (b) captura de ventana en vivo con control remoto (como RustDesk/Sunshine, PoC-1…4 del proyecto) | Alto: es otro proyecto. Se hará como **prototipo medido**, no como promesa |
| Apps nativas "abrir aparte" | Ya | Panel Apps (lista cerrada) | — |

Para Notion "funcional como la app": la vía fiable es **Notion web en un panel con perfil persistente** (misma cuenta, mismos datos); eso es lo que se implementa en la Fase 3.

## Fases (cada una termina con pruebas E2E reales, doc y commit)
| # | Fase | Entregable | Verificación |
|---|---|---|---|
| 0 | Investigación de Deska ✅ | Esta sección | — |
| 1 | ✅ **Tema vs. apps + fondos con imágenes** | El tema claro/oscuro solo cambia el "chrome" de la app (barras, espacios, menús, notas, revisión); **terminal, editor, navegador, apps y agentes conservan su aspecto**. Fondos: "＋ Mi imagen…" siempre visible, imágenes guardadas reutilizables, galería incluida ampliada | E2E: con tema claro los paneles de apps siguen oscuros; el fondo-imagen persiste |
| 2 | ✅ **UI estilo Deska** | Barra superior flotante con migas (proyecto › rama) y estado de tareas; **rail de Espacios** vertical a la izquierda con miniaturas; **dock inferior** (Añadir panel, herramientas, estado de agentes); HUD de zoom abajo-derecha; paneles con cabecera compacta y estados (Running/Done) | Capturas + E2E de navegación |
| 3 | **Apps web completas** | Catálogo "Apps web" (Notion, Gmail, Google Docs/Calendar, Figma, Linear, Slack, GitHub, Miro…) con **perfil persistente por app**, permisos por sitio (portapapeles, notificaciones con confirmación), **descargas con confirmación y carpeta propia**, subida de archivos, user-agent propio, pestañas ya hechas | E2E con sitio local (persistencia de cookies/localStorage entre reinicios, permisos, descarga confirmada). Inicio de sesión real: manual por el usuario |
| 4 | **Apps nativas en el lienzo (prototipo)** | Investigación + prototipo de `SetParent`/captura de ventana en Windows con 3 apps (Bloc de notas, Calculadora, Notion de escritorio) y tabla de qué funciona | Medido, con veredicto Cumple/Parcial/No cumple por app |
| 5 | **Agentes e Inbox al estilo Deska** | Tareas con worktree, Inbox de permisos/cambios, hilos por agente, notificaciones | E2E con adaptadores reales (Claude/OpenCode) |
| 6 | **Paleta de comandos y atajos reasignables** | `Ctrl+K` (buscar paneles, archivos, acciones), `Ctrl+L` preguntar al agente sobre lo abierto; atajos configurables | E2E |
| 7 | **Paneles extensibles (opcional)** | `panel.json` + sandbox web para paneles propios | Diseño aparte |

## Reglas de trabajo
* Una fase por vez, cada una con **E2E real repetido**, documentación honesta (qué no se verificó) y commit.
* Nada que requiera credenciales del usuario se automatiza: los inicios de sesión (Notion, Google) los hace él.
* Seguridad: cada nuevo tipo de panel entra con su lista blanca y pruebas de lo que NO puede hacer.
