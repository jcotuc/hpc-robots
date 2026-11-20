@echo off
rem Crea la tarea "HPC Jefe Telegram": el Jefe escucha Telegram todo el tiempo y contesta en segundos. Sin ventana, sin admin.
rem Cada 5 min revisa que siga encendida: si ya corre no abre otra; si se cayo (sin red, reinicio) la vuelve a levantar.
schtasks /Create /TN "HPC Jefe Telegram" /TR "wscript.exe //B //Nologo \"%~dp0escucha-oculto.vbs\"" /SC MINUTE /MO 5 /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 13); Set-ScheduledTask -TaskName 'HPC Jefe Telegram' -Settings $s | Out-Null"
schtasks /Run /TN "HPC Jefe Telegram" >nul
echo Tarea "HPC Jefe Telegram" creada y encendida: el Jefe ya contesta al momento.
pause
