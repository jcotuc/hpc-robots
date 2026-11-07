@echo off
rem Crea la tarea "HPC Truper" (ver programar-tarea.ps1). Sin permisos de admin.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0programar-tarea.ps1"
pause
