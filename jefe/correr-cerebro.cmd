@echo off
rem Cerebro del Jefe (IA local). Lo usa la tarea "HPC Jefe Cerebro"; sin cola termina al instante.
cd /d "%~dp0"
if not exist logs mkdir logs
node --env-file=.env cerebro.mjs >> "logs\cerebro-consola.log" 2>&1
