@echo off
rem Monitor en vivo del robot de correos. Cerrar esta ventana NO detiene el robot.
cd /d "%~dp0"
title Robot correos - monitor
node ver-vivo.mjs
pause
