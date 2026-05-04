@echo off
SETLOCAL EnableDelayedExpansion
TITLE DYComment + HY-MT Model Server

:: Chuyen vao thu muc chua file .bat
cd /d "%~dp0"

echo ======================================================
echo    DYComment + HY-MT (Hunyuan 1.8B) - STARTUP
echo ======================================================
echo.

echo [1/3] Kiem tra file he thong...
if not exist "models\hy-mt-1.5-1.8b.gguf" (
    echo [ERROR] Khong tim thay file model: models\hy-mt-1.5-1.8b.gguf
    pause
    exit /b
)

if not exist "bin\model-server\llama-server.exe" (
    echo [ERROR] Khong tim thay engine: bin\model-server\llama-server.exe
    pause
    exit /b
)

echo [2/3] Dang khoi dong Model Server (Background)...
:: Su dung tham so toi uu cho CPU (AVX2)
start "DY-Model-Server" /min "bin\model-server\llama-server.exe" -m "models\hy-mt-1.5-1.8b.gguf" --port 8021 --ctx-size 2048 --n-gpu-layers 0 --threads 8

echo.
echo Dang cho Model Server khoi tao (khoang 5 giay)...
timeout /t 5 /nobreak > nul

echo [3/3] Dang khoi dong Web App...
echo.
call npm run dev

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Khong the khoi dong Web App. Hay kiem tra xem ban da cai Node.js chua.
    pause
)

echo.
echo Da dong ung dung.
pause
