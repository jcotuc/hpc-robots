@echo off
rem Corre el robot una vez. Lo usa el Programador de tareas.
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
node --env-file=.env enviar-correos.mjs >> "logs\consola-%HOY%.log" 2>&1
