@echo off
rem 学习助手启动器：构建最新代码并以无开发工具栏的生产模式启动。
rem 为什么每次都构建：多 AI 协作频繁更新代码，直接跑 out/ 旧产物会
rem 出现"改了没生效"的陈旧构建问题；electron-vite 增量构建约 10 秒。
rem 注意：本文件保持简单结构（无 goto/label），LF 行尾在 cmd 下也安全。
chcp 65001 >nul
title 学习助手 - 启动器
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_RENDERER_URL="
where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm 命令。请先安装 Node.js LTS: https://nodejs.org/
  pause
  exit /b 1
)
echo [1/2] 正在构建最新代码（约 10 秒，首次会更久）...
call npm run build
if errorlevel 1 (
  echo.
  echo [错误] 构建失败。请把上方报错截图反馈。
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 缺少 Electron 运行时。请在项目目录执行 npm install 后重试。
  pause
  exit /b 1
)
echo [2/2] 正在启动学习助手...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
