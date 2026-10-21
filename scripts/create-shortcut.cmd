@echo off
chcp 65001 >nul
set "APPDIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $l=Join-Path $d 'VibeTabula.lnk'; if (Test-Path $l) { Remove-Item $l -Force }; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath=$env:APPDIR+'VibeTabula.exe'; $s.WorkingDirectory=$env:APPDIR; $s.IconLocation=$env:APPDIR+'VibeTabula.exe,0'; $s.Description='VibeTabula'; $s.Save()"
rem refresh the Windows icon cache so the new icon shows up right away
ie4uinit.exe -show >nul 2>&1
echo Ярлык VibeTabula создан на рабочем столе.
timeout /t 3 >nul
