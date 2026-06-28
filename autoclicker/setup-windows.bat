@echo off
REM Oddexus autoclicker - setup for Windows.
cd /d "%~dp0"
echo === Oddexus autoclicker setup ===

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python hittades inte. Installera Python 3.11 fran https://www.python.org/downloads/
  echo Bocka i "Add Python to PATH" under installationen. Kor sedan setup-windows.bat igen.
  pause
  exit /b 1
)

if not exist ".venv" (
  echo Skapar virtuell miljo (.venv)...
  python -m venv .venv
)
call .venv\Scripts\activate.bat

echo Installerar Playwright...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo Laddar ner bot-Chrome (Chromium)...
python -m playwright install chromium

echo.
echo Klart! Starta botten med:
echo     run-windows.bat
pause
