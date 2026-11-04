@echo off
rem Crea la tarea "HPC Guias CSHP": lunes a sabado, cada 3 minutos de 7:00 a 18:00
schtasks /Create /TN "HPC Guias CSHP" /TR "\"%~dp0correr.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 07:00 /RI 3 /DU 11:00 /F
if %errorlevel%==0 (echo Tarea creada. Para verla: Programador de tareas ^> "HPC Guias CSHP") else (echo No se pudo crear la tarea)
pause
