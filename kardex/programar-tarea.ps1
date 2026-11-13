# Crea la tarea "HPC Kardex": lunes a sabado 6:30, 12:30 y 17:30. Sin admin (corre con tu usuario, sesion abierta).
$ErrorActionPreference = 'Stop'
$cmd = Join-Path $PSScriptRoot 'correr.cmd'
$dias = 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'
$triggers = '06:30','12:30','17:30' | ForEach-Object { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $dias -At $_ }
$accion = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $PSScriptRoot
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 50)
Register-ScheduledTask -TaskName 'HPC Kardex' -Action $accion -Trigger $triggers -Settings $ajustes -Force | Out-Null
Write-Host 'Tarea "HPC Kardex" creada: L-S 6:30, 12:30 y 17:30.' -ForegroundColor Green
Write-Host 'Recuerda: la sesion de Windows debe estar DESBLOQUEADA a esas horas (Kardex usa mouse y teclado).'
