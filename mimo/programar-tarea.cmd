@echo off
rem Crea la tarea "HPC MiMO CSHP": lunes a sabado, cada 10 minutos de 5:55 a 20:25
schtasks /Create /TN "HPC MiMO CSHP" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 05:55 /RI 10 /DU 14:30 /F
if %errorlevel%==0 (echo Tarea creada. Para verla: Programador de tareas ^> "HPC MiMO CSHP") else (echo No se pudo crear la tarea)
pause
