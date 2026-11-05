@echo off
rem Crea la tarea "HPC Correos": lunes a sabado, cada 2 minutos de 7:00 a 20:00
schtasks /Create /TN "HPC Correos" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 07:00 /RI 2 /DU 13:00 /F
if %errorlevel%==0 (echo Tarea creada. Para verla: Programador de tareas ^> "HPC Correos") else (echo No se pudo crear la tarea)
pause
