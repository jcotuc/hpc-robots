@echo off
rem Corre el robot una vez (tarea programada). Usa AMBIENTE de .env
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
node --env-file=.env despachar.mjs >> "logs\consola-%HOY%.log" 2>&1
