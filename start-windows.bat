@echo off
title Bel Sekolah Otomatis
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js belum terpasang. Unduh di https://nodejs.org lalu jalankan lagi file ini. & pause & exit /b)
start "" /min cmd /c "timeout /t 3 >nul & start chrome --new-window --autoplay-policy=no-user-gesture-required http://localhost:8080/player"
:loop
node run.js
echo Server berhenti, menyalakan ulang dalam 5 detik...
timeout /t 5 >nul
goto loop
