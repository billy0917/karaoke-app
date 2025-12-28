@echo off
setlocal

REM One-click local runner for Windows
REM - Installs deps
REM - Starts Vite dev server

set SCRIPT_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run-local.ps1"

endlocal
