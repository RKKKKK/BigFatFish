@echo off
chcp 65001 >nul
setlocal
rem Local launcher: data stays in .whale-home inside this folder, no scheduled task.
set "WHALE_HOME=%~dp0.whale-home"
node "%~dp0scripts\local-launch.mjs"
if errorlevel 1 pause
exit /b
