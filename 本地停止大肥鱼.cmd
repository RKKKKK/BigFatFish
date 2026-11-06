@echo off
chcp 65001 >nul
setlocal
rem Local stop entry: stops the desktop service and the pet window; data stays in .whale-home.
set "WHALE_HOME=%~dp0.whale-home"
node "%~dp0scripts\local-stop.mjs"
if errorlevel 1 pause
exit /b
