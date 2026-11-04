@echo off
rem Corre el worker una vez y guarda la salida en logs\AAAA-MM-DD.log (lo usa el Programador de tareas)
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
echo ===== %date% %time% ===== >> "logs\%HOY%.log"
node --env-file=.env sync-citas.mjs >> "logs\%HOY%.log" 2>&1
