@echo off
chcp 65001 >nul
echo 🎮 Agentica AI Battle - Quick Start
echo ====================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js not found! Please install Node.js 18+
    echo    Visit: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_VERSION=%%a
if %NODE_VERSION% LSS 18 (
    echo ❌ Node.js version is too old! Please upgrade to 18+
    pause
    exit /b 1
)

echo ✅ Node.js detected
echo.

REM Enter server directory
cd server

REM Check if node_modules exists
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo ❌ Failed to install dependencies
        pause
        exit /b 1
    )
    echo ✅ Dependencies installed
) else (
    echo ✅ Dependencies already installed
)

echo.

REM Check for .env file
if not exist ".env" (
    echo ⚠️  No .env file found!
    echo.
    echo Please create a .env file with your OpenRouter API key:
    echo.
    echo    echo OPENROUTER_API_KEY=your_api_key_here ^> .env
    echo.
    echo Get your free API key at: https://openrouter.ai/
    echo.
    set /p CONTINUE="Continue without AI agents? (y/n): "
    if /I not "%CONTINUE%"=="y" exit /b 1
)

echo.
echo 🚀 Starting Agentica AI Battle Server...
echo.
echo    🌐 Game will be available at: http://localhost:3000
echo    ⏹️  Press Ctrl+C to stop
echo.

call npm start

pause