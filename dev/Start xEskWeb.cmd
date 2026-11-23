@echo off
setlocal
"%~dp0runtime\python.exe" "%~dp0esk_native.py" --dist "%~dp0dist" --recorder "%~dp0xlogic_capture.exe" --store "%~dp0recordings"
if errorlevel 1 pause
