@echo off
cd /d "%~dp0"
echo Brivviant Studio starting on http://localhost:8080
python -m http.server 8080
pause
