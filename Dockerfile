# Telegram's own Bot API server (lets the bot download files up to 2GB) + the Node bot
FROM aiogram/telegram-bot-api:latest
RUN apk add --no-cache nodejs
WORKDIR /app
COPY package.json bot.js start.sh ./
RUN chmod +x start.sh
ENTRYPOINT []
CMD ["/app/start.sh"]
