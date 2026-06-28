@echo off
cd /d "%~dp0"
if not exist ".venv" (
  echo Kor setup-windows.bat forst.
  pause
  exit /b 1
)
call .venv\Scripts\activate.bat
python playwright_bot.py %*
pause
