@echo off
cd /d "%~dp0"
call npm.cmd install
if not exist .env (copy .env.example .env & echo Se creo .env: llena MONITOR_* ^(se pueden copiar de correos\.env^).) else (echo .env ya existe.)
pause
