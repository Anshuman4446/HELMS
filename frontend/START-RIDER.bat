@echo off
setlocal
cd /d "%~dp0backend"
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:3000/health'; if ($r.StatusCode -eq 200 -and $r.Content -like '*HELMS backend is running*') { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Starting HELMS backend...
  start "HELMS backend" cmd /k "cd /d ""%~dp0backend"" && npm start"
  timeout /t 3 /nobreak >nul
)
start "" "http://127.0.0.1:3000/index.html"

@echo off
setlocal
cd /d "%~dp0backend"
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:3000/health'; if ($r.StatusCode -eq 200 -and $r.Content -like '*HELMS backend is running*') { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Starting HELMS backend...
  start "HELMS backend" cmd /k "cd /d ""%~dp0backend"" && npm start"
  timeout /t 3 /nobreak >nul
)
start "" "http://127.0.0.1:3000/index.html"

