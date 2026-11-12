@echo off
rem 一次性脚本：在桌面创建「学习助手」快捷方式（指向 启动学习助手.bat，
rem 图标取 Electron 运行时；M5 打包期换成正式应用图标）。
chcp 65001 >nul
title 创建桌面快捷方式
cd /d "%~dp0"
if not exist "启动学习助手.bat" (
  echo [错误] 未找到 启动学习助手.bat，请在本目录运行。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\学习助手.lnk'); $lnk.TargetPath = '%~dp0启动学习助手.bat'; $lnk.WorkingDirectory = '%~dp0'; $lnk.IconLocation = '%~dp0node_modules\electron\dist\electron.exe,0'; $lnk.Save()" >nul
if errorlevel 1 (
  echo [错误] 快捷方式创建失败。可手动右键 启动学习助手.bat 发送到桌面快捷方式。
  pause
  exit /b 1
)
echo 已在桌面创建「学习助手」快捷方式，双击即可启动。
pause
