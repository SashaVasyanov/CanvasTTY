@echo off
chcp 65001 >nul
set "APPDIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'CanvasTTY.lnk')); $s.TargetPath=$env:APPDIR+'CanvasTTY.exe'; $s.WorkingDirectory=$env:APPDIR; $s.IconLocation=$env:APPDIR+'resources\app\renderer\assets\icon.ico'; $s.Description='CanvasTTY'; $s.Save()"
echo Ярлык CanvasTTY создан на рабочем столе.
pause
