@echo off
rem Crea la tarea "HPC Jefe": lunes a sabado, cada 3 minutos de 6:00 a 21:00, tambien con bateria
rem Sin ventana negra: wscript abre correr.cmd oculto (correr-oculto.vbs)
schtasks /Create /TN "HPC Jefe" /TR "wscript.exe //B //Nologo \"%~dp0correr-oculto.vbs\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 06:00 /RI 3 /DU 15:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5); Set-ScheduledTask -TaskName 'HPC Jefe' -Settings $s | Out-Null"
echo Tarea "HPC Jefe" creada: cada 3 minutos, con o sin cargador, sin ventana negra.
pause
