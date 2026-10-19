# Registra (o elimina) una tarea programada que inicia el Core de AI Workspace al iniciar sesión,
# sin ventana y sin privilegios de administrador (se ejecuta como el usuario actual).
# Uso:   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#        powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Remove
# El Core escucha solo en 127.0.0.1 (ver docs/06); este script no abre puertos ni cambia el firewall.
param([switch]$Remove)

$TaskName = 'AIWorkspaceCore'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarea '$TaskName' eliminada."
  exit 0
}

$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$main = Join-Path $repo 'services\core\src\main.ts'
$dataDir = Join-Path $env:LOCALAPPDATA 'AIWorkspace'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# cmd /c permite redirigir la salida al registro del Core sin abrir una ventana (-WindowStyle Hidden en PowerShell).
$cmd = "`"$node`" --import tsx `"$main`" >> `"$dataDir\core.log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Tarea '$TaskName' registrada: el Core se iniciará al iniciar sesión (usa -Remove para quitarla)."
