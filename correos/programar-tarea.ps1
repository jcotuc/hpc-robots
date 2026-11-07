# Crea la tarea "HPC Correos": lunes a sabado, cada 2 minutos de 7:00 a 20:00. Sin permisos de admin.
# A diferencia de schtasks.exe, deja la tarea corriendo aunque la laptop este en BATERIA
# y la recupera si la PC estuvo suspendida.
$ErrorActionPreference = 'Stop'
$nombre = 'HPC Correos'
$cmd = Join-Path $PSScriptRoot 'correr.cmd'

$accion = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $PSScriptRoot
$disparo = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday, Saturday -At '07:00'
$disparo.Repetition = (New-ScheduledTaskTrigger -Once -At '07:00' -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Hours 13)).Repetition
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$quien = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparo -Settings $ajustes -Principal $quien -Force | Out-Null
$t = Get-ScheduledTask -TaskName $nombre
Write-Output "Tarea '$nombre' creada. Estado: $($t.State). Bateria permitida: $($t.Settings.DisallowStartIfOnBatteries -eq $false)"
Write-Output "Proxima corrida: $((Get-ScheduledTaskInfo -TaskName $nombre).NextRunTime)"
