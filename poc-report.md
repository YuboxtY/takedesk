# Informe PoC-5 / entorno

Fecha: 2026-10-19T16:11:00.319Z
Resultado: 12/15 comprobaciones OK

| Comprobación | Resultado | Detalle | ms |
|---|---|---|---|
| Entorno | OK | win32 10.0.26200 x64 \| node v26.5.1 \| RAM total 15.9 GB, disponible 5.2 GB \| CPU 12 hilos \| disco libre en temp 61.0 GB \| {"WindowsProductName":"Windows 10 Home","WindowsVersion":"2009","OsBuildNumber":"26200"} | 2866 |
| Herramienta: git | OK | C:\Program Files\Git\mingw64\bin\git.exe · git version 2.55.0.windows.3 | 43 |
| Herramienta: claude | OK | C:\Users\juanp\.local\bin\claude.exe · 2.1.220 (Claude Code) | 186 |
| Herramienta: codex | **FALLA** | no se encuentra en PATH | 39 |
| Herramienta: opencode | OK | C:\Users\juanp\AppData\Roaming\npm\opencode.cmd [SHIM .cmd/.bat] · 1.18.25 | 782 |
| Herramienta: agy | **FALLA** | no se encuentra en PATH | 41 |
| Herramienta: pnpm | OK | C:\Users\juanp\AppData\Roaming\npm\pnpm.cmd [SHIM .cmd/.bat] · 10.0.0 | 493 |
| node-pty: shell real, eco y cierre | OK | eco correcto con powershell.exe; terminó con código -1073741510 | 1804 |
| PowerShell con entorno recortado (error 8009001d) | OK | normal: ok; con lista blanca de entorno: ok | 751 |
| killTree mata al hijo y al nieto | OK | sin procesos huérfanos | 306 |
| token de inicio de proceso | OK | token propio: 134368998479660673 | 426 |
| SQLite: abrir (WAL), migrar, backup y verificar | OK | journal_mode=wal; backup 94208 bytes, integridad ok | 37 |
| Git: worktree + borrado protegido | OK | rama task/t1-prueba; borrado protegido OK | 533 |
| Git: rutas largas (> 260 caracteres) | **FALLA** | git worktree falló: Preparing worktree (new branch 'task/t2-larga') | 151 |
| Agente desacoplado (wrapper): ejecutar, cancelar y reenganchar | OK | reenganche OK (13 eventos), cancelación OK | 3055 |
