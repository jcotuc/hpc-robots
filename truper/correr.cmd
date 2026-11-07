@echo off
rem Corre el robot del Catalogo Truper (2-3 h). Lo usa la tarea mensual; tambien se puede correr a mano.
rem Si se corta, volver a correrlo retoma donde iba. Archivos en salida\
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%i
if "%HOY%"=="" set HOY=sin-fecha
node --env-file=.env scraper.mjs %* >> "logs\consola-%HOY%.log" 2>&1
