@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to run the local website.
  echo Install Node.js, then double-click start.bat again.
  pause
  exit /b 1
)
if not exist "node_modules\sql.js\dist\sql-wasm.wasm" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo npm is required to install the SQLite dependency.
    pause
    exit /b 1
  )
  echo Installing the SQLite dependency for the first run...
  call npm install
  if errorlevel 1 (
    echo Could not install the SQLite dependency.
    pause
    exit /b 1
  )
)
node server.js
pause
