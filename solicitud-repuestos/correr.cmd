@echo off
rem Corre el robot una vez (para la tarea programada, cuando lea de Supabase)
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
node --env-file=.env solicitar-repuestos.mjs >> "logs\consola-%HOY%.log" 2>&1
