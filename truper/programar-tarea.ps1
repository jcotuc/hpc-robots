# Crea la tarea "HPC Truper": dia 1 de cada mes a las 2:00. Sin permisos de admin.
# Si la laptop estaba apagada o suspendida a esa hora, corre en cuanto se pueda (StartWhenAvailable),
# tambien con BATERIA. Maximo 6 h por corrida; si ya hay una corriendo no abre otra.
$ErrorActionPreference = 'Stop'
$nombre = 'HPC Truper'
$cmd = Join-Path $PSScriptRoot 'correr.cmd'

# El disparo mensual se crea con schtasks (New-ScheduledTaskTrigger no tiene mensual)
schtasks /Create /TN $nombre /TR "`"$cmd`"" /SC MONTHLY /D 1 /ST 02:00 /F | Out-Null
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
$accion = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $PSScriptRoot
Set-ScheduledTask -TaskName $nombre -Settings $ajustes -Action $accion | Out-Null

$t = Get-ScheduledTask -TaskName $nombre
Write-Output "Tarea '$nombre' creada. Estado: $($t.State). Bateria permitida: $($t.Settings.DisallowStartIfOnBatteries -eq $false)"
Write-Output "Proxima corrida: $((Get-ScheduledTaskInfo -TaskName $nombre).NextRunTime)"
Write-Output "Correrla ya:  schtasks /Run /TN `"$nombre`""
