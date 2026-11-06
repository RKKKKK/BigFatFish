@echo off
chcp 65001 >nul
powershell.exe -NoProfile -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 pause
