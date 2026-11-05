@echo off
rem Crea la tarea "HPC Digitadores CSHP": lunes a sabado, cada 3 minutos de 7:00 a 18:00
schtasks /Create /TN "HPC Digitadores CSHP" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 07:00 /RI 3 /DU 11:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
rem Que corra tambien con bateria, no se detenga al desconectar el cargador y recupere corridas perdidas
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30); Set-ScheduledTask -TaskName 'HPC Digitadores CSHP' -Settings $s | Out-Null"
if %errorlevel%==0 (echo Tarea creada: corre cada 3 minutos, con o sin cargador.) else (echo Tarea creada, pero no se pudo quitar la condicion de bateria. Quitala a mano en Programador de tareas ^> Condiciones.)
echo Para verla: Programador de tareas ^> "HPC Digitadores CSHP"
pause
