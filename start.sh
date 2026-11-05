#!/bin/sh
set -e
mkdir -p /data/tgapi /data/bot /tmp/tgapi
telegram-bot-api --api-id="$TELEGRAM_API_ID" --api-hash="$TELEGRAM_API_HASH" --local \
  --dir=/data/tgapi --temp-dir=/tmp/tgapi --http-port=8081 --http-ip-address=127.0.0.1 &
sleep 3
exec node /app/bot.js
