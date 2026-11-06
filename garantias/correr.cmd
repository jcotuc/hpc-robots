@echo off
rem Robot de garantias manuales (NDC) en PRODUCCION. Se corre a mano: doble clic.
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
set SYNC_ENV=prod
call npx.cmd tsx sync.ts 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath 'logs\%HOY%.log' -Append"
echo.
pause
