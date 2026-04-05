#!/bin/zsh
cd "$(dirname "$0")"
PORT=4173
URL="http://127.0.0.1:${PORT}/index.html"

echo "家計簿アプリを起動します。"
echo "URL: ${URL}"
echo "停止するには、このウィンドウで Ctrl+C を押してください。"

python3 -m http.server "${PORT}" >/tmp/kakeibo-app-server.log 2>&1 &
SERVER_PID=$!

sleep 1
open "${URL}"
wait "${SERVER_PID}"
