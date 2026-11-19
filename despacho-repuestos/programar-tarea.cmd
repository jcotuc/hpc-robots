@echo off
rem Crea la tarea "HPC Despacho Repuestos": lunes a sabado, cada 3 minutos de 6:00 a 22:00
rem Sin ventana negra: wscript abre correr.cmd oculto (correr-oculto.vbs)
schtasks /Create /TN "HPC Despacho Repuestos" /TR "wscript.exe //B //Nologo \"%~dp0correr-oculto.vbs\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 06:00 /RI 3 /DU 16:00 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30); Set-ScheduledTask -TaskName 'HPC Despacho Repuestos' -Settings $s | Out-Null"
echo Tarea creada: "HPC Despacho Repuestos" cada 3 minutos, L-S 6:00-22:00. Requiere AMBIENTE=prod en .env
pause
