@echo off
rem Crea la tarea "HPC Jefe": lunes a sabado, cada 5 minutos de 6:00 a 21:00, tambien con bateria
schtasks /Create /TN "HPC Jefe" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 06:00 /RI 5 /DU 15:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Set-ScheduledTask -TaskName 'HPC Jefe' -Settings $s | Out-Null"
echo Tarea "HPC Jefe" creada: cada 5 minutos, con o sin cargador.
pause
