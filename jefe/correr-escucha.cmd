@echo off
rem El Jefe escuchando Telegram todo el tiempo (tarea "HPC Jefe Telegram").
cd /d "%~dp0"
if not exist logs mkdir logs
node --env-file=.env escucha.mjs >> "logs\escucha-consola.log" 2>&1
