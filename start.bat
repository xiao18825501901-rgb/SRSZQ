@echo off
rem ============================================
rem  三人四子棋 · Three-Player Connect Four
rem  一键启动：安装缺失依赖 + 启动 dev server
rem ============================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/2] 首次运行：安装依赖中，请稍候……
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 依赖已就绪。
)

echo [2/2] 正在启动本地服务器： http://localhost:5173
echo        （关闭本窗口 = 停止服务器）
start "" http://localhost:5173
call npm run dev
pause
