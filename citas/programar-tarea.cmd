@echo off
rem Crea la tarea "HPC Citas CSHP": lunes a sabado, cada 5 minutos de 6:00 a 22:00
schtasks /Create /TN "HPC Citas CSHP" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 06:00 /RI 5 /DU 16:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
rem Que corra tambien con bateria, no se detenga al desconectar el cargador y recupere corridas perdidas
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1); Set-ScheduledTask -TaskName 'HPC Citas CSHP' -Settings $s | Out-Null"
if %errorlevel%==0 (echo Tarea creada: corre cada 5 minutos, con o sin cargador.) else (echo Tarea creada, pero no se pudo quitar la condicion de bateria. Quitala a mano en Programador de tareas ^> Condiciones.)
echo Para verla: Programador de tareas ^> "HPC Citas CSHP"
pause
