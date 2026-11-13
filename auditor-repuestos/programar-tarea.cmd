@echo off
rem Crea la tarea "HPC Auditor Repuestos": lunes a sabado, cada 3 minutos de 6:00 a 22:00
schtasks /Create /TN "HPC Auditor Repuestos" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 06:00 /RI 3 /DU 16:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Set-ScheduledTask -TaskName 'HPC Auditor Repuestos' -Settings $s | Out-Null"
echo Tarea creada: "HPC Auditor Repuestos" cada 3 minutos, L-S 6:00-22:00.
pause
