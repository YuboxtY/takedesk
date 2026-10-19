# 04 · Diagramas técnicos (Mermaid)

> Fecha: 2026-10-18. Representan la **arquitectura propuesta** (`03`), no software existente. Se renderizan en GitHub y en la mayoría de visores Markdown con Mermaid.

## 1. Arquitectura general

```mermaid
flowchart LR
  subgraph PC["PC Windows - sesion interactiva del usuario"]
    UI["Electron UI"]
    CORE["Core Service<br/>Node + Fastify"]
    DB[("SQLite WAL")]
    LOGS[("NDJSON runs")]
    AG["Agentes CLI / SDK"]
    WT["Git worktrees"]
    HOST["Host remoto<br/>RustDesk o Sunshine"]
    APPS["Chrome, IDE, apps"]
  end
  subgraph AND["Telefono Android"]
    APP["App AI Workspace<br/>RN + Expo Dev Build"]
    VIEW["Cliente de escritorio remoto"]
  end
  NET{{"Red privada Tailscale"}}
  UI -- "IPC + WS loopback" --> CORE
  CORE --> DB
  CORE --> LOGS
  CORE --> AG
  AG --> WT
  AG -. "lanzan" .-> APPS
  HOST -. "captura consola" .-> APPS
  APP -- "HTTPS/WS autenticado" --> NET
  VIEW -- "video + entrada" --> NET
  NET --> CORE
  NET --> HOST
```

## 2. Arquitectura de componentes

```mermaid
flowchart TB
  subgraph Clientes
    D["apps/desktop"]
    M["apps/mobile"]
  end
  subgraph Core["services/core"]
    API["HTTP + WS API"]
    AUTH["Auth y permisos"]
    SCH["Scheduler"]
    ORC["Orchestrator"]
    ADP["Agent adapters"]
    GIT["Git engine"]
    PTY["PTY manager<br/>node-pty"]
    REC["Reconciler"]
    RET["Retencion y backups"]
  end
  subgraph Datos
    SQL[("SQLite")]
    ND[("NDJSON")]
    SEC[("Credential Manager")]
  end
  D --> API
  M --> API
  API --> AUTH
  API --> SCH
  API --> PTY
  SCH --> ORC
  SCH --> ADP
  ADP --> GIT
  AUTH --> SEC
  SCH --> SQL
  ADP --> ND
  REC --> SQL
  RET --> SQL
  RET --> ND
```

## 3. Despliegue Windows - Android

```mermaid
flowchart LR
  subgraph W["Windows 10/11"]
    S1["Task Scheduler: supervisor + core (usuario)"]
    S2["Servicio: host remoto"]
    S3["Electron (opcional)"]
  end
  subgraph T["Tailscale tailnet"]
    TN["WireGuard cifrado"]
  end
  subgraph A["Android"]
    A1["App agentes"]
    A2["Visor remoto<br/>externo o modulo nativo"]
    A3["Keystore: clave de dispositivo"]
  end
  S1 --- TN
  S2 --- TN
  TN --- A1
  TN --- A2
  A3 --- A1
  INET(("Internet publica")) -. "puertos NO expuestos" .- W
```

## 4. Casos de uso

```mermaid
flowchart LR
  U(["Usuario"])
  subgraph Desktop
    UC1["Abrir proyecto"]
    UC2["Lanzar agente"]
    UC3["Revisar diff y aprobar merge"]
    UC4["Usar orquestador"]
    UC5["Terminal y editor"]
  end
  subgraph Android
    UC6["Ver estado de agentes"]
    UC7["Aprobar permisos"]
    UC8["Ver mi PC y controlarla"]
    UC9["Gestionar dispositivos"]
  end
  U --> UC1
  U --> UC2
  U --> UC3
  U --> UC4
  U --> UC5
  U --> UC6
  U --> UC7
  U --> UC8
  U --> UC9
  UC4 -. "incluye" .-> UC2
  UC3 -. "requiere" .-> UC7
```

## 5. Entidades y relaciones

```mermaid
erDiagram
  PROJECT ||--o{ WORKSPACE : tiene
  PROJECT ||--o{ TASK : contiene
  PROJECT ||--o{ WORKTREE : gestiona
  TASK ||--o{ TASK_DEPENDENCY : depende
  TASK ||--o{ AGENT_RUN : ejecuta
  PLAN ||--o{ TASK : origina
  AGENT_PROFILE ||--o{ AGENT_RUN : usa
  WORKTREE ||--o| AGENT_RUN : aisla
  AGENT_RUN ||--o{ AGENT_EVENT_INDEX : emite
  AGENT_RUN ||--o{ APPROVAL : solicita
  AGENT_RUN ||--o| REVIEW : genera
  TRUSTED_DEVICE ||--o{ REMOTE_SESSION : abre
  TRUSTED_DEVICE ||--o{ APPROVAL : decide
  TRUSTED_DEVICE ||--o{ AUDIT_LOG : produce
  PROJECT { string id PK
    string name
    string rootPath
    datetime lastOpenedAt }
  TASK { string id PK
    string projectId FK
    string planId FK
    string status
    int priority }
  AGENT_RUN { string id PK
    string taskId FK
    string profileId FK
    string worktreeId FK
    int pid
    datetime pidStartTime
    string state
    string externalSessionId }
  WORKTREE { string id PK
    string branch
    string path
    string baseCommit
    string status }
  AGENT_EVENT_INDEX { string runId FK
    int seq
    string kind
    int fileOffset
    string summary }
  APPROVAL { string id PK
    string runId FK
    string kind
    string status
    string decidedByDevice FK }
  TRUSTED_DEVICE { string id PK
    string name
    string publicKey
    string permissions
    datetime revokedAt }
  AUDIT_LOG { int id PK
    string deviceId FK
    string action
    datetime at }
```

## 6. Secuencia: ejecutar un agente

```mermaid
sequenceDiagram
  actor U as Usuario
  participant UI as Electron/Android
  participant C as Core
  participant G as Git engine
  participant A as Adaptador
  participant P as CLI/SDK del agente
  U->>UI: Lanzar agente con prompt
  UI->>C: POST /v1/runs
  C->>C: Validar permisos y limites
  C->>G: Crear rama y worktree
  G-->>C: ruta del worktree
  C->>A: start(request)
  A->>P: spawn con cwd=worktree
  C-->>UI: run.created
  loop Streaming
    P-->>A: evento nativo
    A-->>C: AgentEvent normalizado
    C->>C: Persistir NDJSON + indice
    C-->>UI: agent.output.delta
  end
  P-->>A: fin
  C-->>UI: agent.run.finished
```

## 7. Secuencia multiagente

```mermaid
sequenceDiagram
  participant S as Scheduler
  participant R as Recursos
  participant A1 as Run A (Claude)
  participant A2 as Run B (Codex)
  participant V as Revisor
  S->>R: hay presupuesto para A?
  R-->>S: si
  S->>A1: start en worktree A
  S->>R: hay presupuesto para B?
  R-->>S: si
  S->>A2: start en worktree B
  par ejecucion paralela
    A1-->>S: eventos
  and
    A2-->>S: eventos
  end
  A1-->>S: finished
  S->>V: tests + diff de A
  A2-->>S: finished
  S->>V: tests + diff de B
  V-->>S: resultados
  S-->>S: cola de integracion secuencial
```

## 8. Flujo de orquestación

```mermaid
flowchart TD
  Q["Solicitud general"] --> AN["Coordinador analiza proyecto<br/>solo lectura"]
  AN --> PL["Plan JSON"]
  PL --> VAL{"Valida esquema,<br/>ciclos y rutas?"}
  VAL -- no --> AN
  VAL -- si --> APR{"Usuario aprueba?"}
  APR -- no --> END1["Descartar o editar"]
  APR -- si --> DAG["Scheduler resuelve dependencias"]
  DAG --> EX["Ejecutar tareas listas en paralelo<br/>dentro de limites"]
  EX --> CHK["Revisor: formato, lint, tests, diff"]
  CHK --> OK{"Paso?"}
  OK -- no --> RT{"Intentos restantes?"}
  RT -- si --> FIX["Tarea de correccion"] --> EX
  RT -- no --> ESC["Escalar al usuario"]
  OK -- si --> INT["Cola de integracion secuencial"]
  INT --> MR{"Usuario aprueba merge?"}
  MR -- si --> M["Merge + re-validar"]
  MR -- no --> END1
  M --> NEXT{"Mas tareas?"}
  NEXT -- si --> DAG
  NEXT -- no --> DONE["Propuesta final"]
```

## 9. Flujo de Git worktrees

```mermaid
flowchart TD
  A["Tarea escritora lista"] --> B{"Repo limpio o cambios locales<br/>no afectados?"}
  B -- no --> BX["Avisar, no tocar"]
  B -- si --> C["git worktree add -b task/ID"]
  C --> D["Agente trabaja en el worktree"]
  D --> E["Formato, lint, tests"]
  E --> F["Capturar diff y riesgos"]
  F --> G{"Aprobado?"}
  G -- no --> K["Conservar o descartar rama"]
  G -- si --> H["Merge a rama de integracion"]
  H --> I{"Conflicto?"}
  I -- si --> J["git merge --abort<br/>pedir resolucion"]
  I -- no --> L["Re-validar tests"]
  L --> M{"Run finalizado y<br/>worktree limpio?"}
  K --> M
  M -- si --> N["git worktree remove + prune"]
  M -- no --> O["Mantener y avisar"]
```

## 10. Flujo de acceso remoto

```mermaid
sequenceDiagram
  actor U as Usuario
  participant App as App Android
  participant C as Core
  participant H as Host remoto (Windows)
  participant V as Visor remoto
  U->>App: Tocar Ver mi PC
  App->>C: GET /v1/remote/status (firmado)
  C->>C: Verificar dispositivo y permiso remote.view
  alt Host disponible
    C-->>App: estado, id de host, token efimero
    App->>V: abrir visor (intent o modulo)
    V->>H: conectar por Tailscale
    H-->>V: aceptar por clave/token efimero
    H-->>V: video de la sesion de consola
    V-->>H: mouse, teclado
    C->>C: registrar remote_session + auditoria
  else Sin host o PC dormida
    C-->>App: Host remoto no disponible / PC dormida
  end
  U->>V: Desconectar
  V-->>H: cierre
  C->>C: cerrar remote_session
```

## 11. Estados de un run de agente

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> starting: recursos disponibles
  queued --> cancelled: cancelar
  starting --> running
  starting --> failed: error de arranque
  running --> waiting_approval: approval.requested
  waiting_approval --> running: aprobado
  waiting_approval --> cancelled: rechazado o expirado
  running --> completed: salida OK verificada
  running --> failed: error
  running --> cancelling: cancelar
  cancelling --> cancelled
  cancelling --> failed: no termina (force)
  cancelling --> completed: termino con exito antes de la cancelacion
  cancelling --> pending_reconciliation: caida de Core
  running --> pending_reconciliation: caida de Core
  waiting_approval --> pending_reconciliation: caida de Core
  pending_reconciliation --> running: reattached
  pending_reconciliation --> resumable: adaptador con resume
  pending_reconciliation --> interrupted: sin evidencia
  resumable --> queued: reanudar como nuevo run
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
  interrupted --> [*]
```

## 12. Autenticación y autorización

```mermaid
sequenceDiagram
  actor U as Usuario
  participant D as Electron
  participant C as Core
  participant P as Android
  rect rgb(235,245,255)
  Note over D,P: Emparejamiento (una vez)
  U->>D: Anadir dispositivo
  D->>C: crear pairing_code (TTL 2 min, un uso)
  C-->>D: QR con code + huella del Core
  P->>P: generar par Ed25519 en Keystore
  P->>C: code + clave publica + nombre
  C-->>D: Aprobar dispositivo X?
  U->>D: Aprobar + elegir permisos
  C->>C: guardar trusted_device (clave publica)
  end
  rect rgb(240,255,240)
  Note over P,C: Uso normal
  P->>C: solicitud firmada (ts, nonce, hash del cuerpo)
  C->>C: verificar firma, no revocado, anti-replay, permiso
  C-->>P: respuesta / token WS corto
  end
  rect rgb(255,240,240)
  Note over D,P: Revocacion
  U->>D: Revocar X
  C->>C: revokedAt, cerrar WS y remote_session
  end
```

## 13. Recuperación ante errores

```mermaid
flowchart TD
  S["Core arranca"] --> Q["PRAGMA quick_check"]
  Q -- falla --> RO["Modo solo lectura +<br/>ofrecer restaurar backup"]
  Q -- ok --> MIG["Migraciones pendientes?<br/>backup previo"]
  MIG --> RUNS["Runs en running/waiting"]
  RUNS --> PM["pending_reconciliation"]
  PM --> ALIVE{"pid y hora de inicio<br/>coinciden?"}
  ALIVE -- si --> RA["reattached"]
  ALIVE -- no --> RES{"Adaptador soporta resume?"}
  RES -- si --> RS["resumable"]
  RES -- no --> IN["interrupted<br/>nunca completed"]
  RA --> WTC["Conciliar worktrees con git worktree list"]
  RS --> WTC
  IN --> WTC
  WTC --> NOTIF["Notificar al usuario"]
  CRASH["Core cae"] --> SUP["Supervisor reinicia con backoff"]
  SUP -- "demasiados reinicios" --> STOP["Detener y notificar"]
  SUP --> S
```

## 14. Respaldos

```mermaid
flowchart LR
  T["Programador diario"] --> B1["Backup API / VACUUM INTO"]
  B1 --> V1["integrity_check de la copia"]
  V1 -- ok --> PK["Empaquetar: BD + settings<br/>sin secretos ni caches"]
  V1 -- fallo --> AL["Alertar"]
  PK --> EN{"Sale del equipo?"}
  EN -- si --> CF["Cifrar"]
  EN -- no --> ST["Guardar local"]
  CF --> ST
  ST --> RT["Retencion 7 diarios, 4 semanales, 3 mensuales"]
  RT --> RV["Prueba periodica de restauracion<br/>en directorio temporal"]
  RV -- fallo --> AL
```

## 15. Dependencias de módulos

```mermaid
flowchart BT
  contracts["contracts"]
  domain["domain"]
  security["security"]
  platform["platform"]
  database["database"]
  gitengine["git-engine"]
  adapters["agent-adapters"]
  orch["orchestrator"]
  core["services/core"]
  uiweb["ui-web"]
  desktop["apps/desktop"]
  mobile["apps/mobile"]
  domain --> contracts
  security --> contracts
  database --> domain
  gitengine --> domain
  adapters --> domain
  adapters --> platform
  orch --> domain
  core --> database
  core --> gitengine
  core --> adapters
  core --> orch
  core --> platform
  core --> security
  uiweb --> contracts
  desktop --> uiweb
  desktop --> contracts
  mobile --> contracts
```

> **Reglas prohibidas (a verificar en CI):** `apps/*` → `services/*`; `agent-adapters` → `database`; cualquier paquete → `apps/*`; ciclos.
