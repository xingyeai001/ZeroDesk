@echo off
rem Zero Desk —— 开发态启动脚本
rem 注意：本机环境变量 ELECTRON_RUN_AS_NODE=1 会把 electron.exe 变成纯 Node，必须先清掉
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
