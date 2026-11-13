@echo off
rem Crea o cambia la tarea "HPC Digitadores CSHP" (lunes a sabado).
rem   programar-tarea.cmd                     cada 3 min de 06:00 a 22:00
rem   programar-tarea.cmd 5                   cada 5 min de 06:00 a 22:00
rem   programar-tarea.cmd 5 07:00 18:00       cada 5 min de 07:00 a 18:00
setlocal
set MIN=%~1
set INI=%~2
set FIN=%~3
if "%MIN%"=="" set MIN=3
if "%INI%"=="" set INI=06:00
if "%FIN%"=="" set FIN=22:00
for /f %%d in ('powershell -NoProfile -Command "$d=[datetime]'%FIN%'-[datetime]'%INI%'; '{0:00}:{1:00}' -f [int][math]::Floor($d.TotalHours),$d.Minutes"') do set DU=%%d
schtasks /Create /TN "HPC Digitadores CSHP" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST %INI% /RI %MIN% /DU %DU% /F
if not %errorlevel%==0 (echo No se pudo crear la tarea & pause & exit /b 1)
rem Que corra tambien con bateria, no se detenga al desconectar el cargador y recupere corridas perdidas
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30); Set-ScheduledTask -TaskName 'HPC Digitadores CSHP' -Settings $s | Out-Null"
echo Tarea lista: cada %MIN% minutos de %INI% a %FIN%, lunes a sabado, con o sin cargador.
echo Para verla: Programador de tareas ^> "HPC Digitadores CSHP"
pause
