@echo off
rem Monitor en vivo del robot de digitadores. Cerrar esta ventana NO detiene el robot.
cd /d "%~dp0"
title Robot digitadores - monitor
node ver-vivo.mjs
pause
