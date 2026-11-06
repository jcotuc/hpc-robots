@echo off
rem Monitor en vivo del robot de citas. Cerrar esta ventana NO detiene el robot.
cd /d "%~dp0"
title Robot citas - monitor
node ver-vivo.mjs
pause
