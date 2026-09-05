@echo off
rem 构建生产版本（输出到 dist/）
cd /d "%~dp0"
call npm run build
if errorlevel 1 (
  echo [ERROR] 构建失败
  pause
  exit /b 1
)
echo.
echo 构建成功：dist\  可用 npm run preview 本地预览
pause
