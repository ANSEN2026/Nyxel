@echo off
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=
if exist "%~dp0release\win-unpacked\Nyxel.exe" (
  start "" "%~dp0release\win-unpacked\Nyxel.exe"
  exit /b
)
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
  exit /b
)
echo Nyxel is not built. Run: npm install ^&^& npm run build
pause
