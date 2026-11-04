@echo off
rem Corre el robot una vez. Lo usa el Programador de tareas.
rem   logs\detalle-AAAA-MM-DD.log  = todo lo que imprime el robot
rem   logs\resumen-AAAA-MM-DD.log  = una linea por llamada (lo escribe el robot)
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
echo ===== %date% %time% ===== >> "logs\detalle-%HOY%.log"
node --env-file=.env imprimir-guias.mjs >> "logs\detalle-%HOY%.log" 2>&1
