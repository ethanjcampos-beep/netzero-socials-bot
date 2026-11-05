#!/bin/sh
set -e
mkdir -p /data/tgapi /data/bot /tmp/tgapi
if echo "$TELEGRAM_API_ID" | grep -Eq '^[0-9]+$'; then
  telegram-bot-api --api-id="$TELEGRAM_API_ID" --api-hash="$TELEGRAM_API_HASH" --local \
    --dir=/data/tgapi --temp-dir=/tmp/tgapi --http-port=8081 --http-ip-address=127.0.0.1 &
  sleep 3
else
  echo "TELEGRAM_API_ID not set: using Telegram cloud API (20MB file limit)"
fi
exec node /app/bot.js
