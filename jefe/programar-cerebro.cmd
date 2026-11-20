@echo off
rem Crea la tarea "HPC Jefe Cerebro": IA local del Jefe. Lunes a sabado, cada 2 min de 6:00 a 21:00, sin ventana. Sin admin.
schtasks /Create /TN "HPC Jefe Cerebro" /TR "wscript.exe //B //Nologo \"%~dp0cerebro-oculto.vbs\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 06:00 /RI 2 /DU 15:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Set-ScheduledTask -TaskName 'HPC Jefe Cerebro' -Settings $s | Out-Null"
echo Tarea "HPC Jefe Cerebro" creada: cada 2 minutos, sin ventana.
pause
