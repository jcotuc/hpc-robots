@echo off
rem Abre el monitor en vivo del robot de guias. Cerrar esta ventana NO detiene el robot.
title Monitor - Robot de guias CSHP
cd /d "%~dp0"
node ver-vivo.mjs
pause
