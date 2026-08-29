@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
set "START_LOCAL_EXIT_CODE=%ERRORLEVEL%"

if not "%START_LOCAL_EXIT_CODE%"=="0" (
  echo.
  echo Start local failed. Review the message above and logs under .local\logs.
  echo Press any key to close this window.
  pause >nul
)

exit /b %START_LOCAL_EXIT_CODE%
