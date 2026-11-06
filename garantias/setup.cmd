@echo off
cd /d "%~dp0"
call npm.cmd install
call npx.cmd playwright install chromium
if not exist .env (copy .env.example .env & echo Se creo .env: llenalo antes de correr.) else (echo .env ya existe.)
pause
