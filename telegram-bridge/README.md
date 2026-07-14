Create a local `.env` file with:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id
```

Then start the single-user bridge:

```sh
npx tsx telegraf.ts
```

Messages from the allowed Telegram user are forwarded to one persistent Pi
session, and Pi's responses are sent back to Telegram.
