# Language Tutor

A Spanish-language tutor built around local Pi coding-agent sessions. Lessons
are authored as Markdown and delivered through a Telegram bot.

## Repository layout

| Path | Purpose |
| --- | --- |
| `agent/` | Tutor configuration and lesson content for the local Pi workspace. |
| `agent/lessons/` | Markdown Spanish lessons, including objectives, vocabulary, and roleplay material. |
| `telegram-bridge/` | TypeScript Telegram bot that manages access, lesson selection, and Pi sessions. |
| `telegram-bridge/doc/` | Architecture, observability, and maintenance notes for the bridge. |

## How it works

The Telegram bridge polls for private Telegram updates. Approved users can
select a lesson, review its material, and start a roleplay. The bridge creates
one in-memory Pi session per user and forwards active lesson responses to that
session. Lesson files are loaded from `agent/lessons/`.

The bridge intentionally has no database or web server. User access is stored
locally, and conversation sessions are lost when the bridge restarts.

## Prerequisites

- Node.js and npm
- A Telegram bot token from BotFather
- Pi authentication configured locally
- A Haimaker API key

## Run the Telegram bridge

1. Install dependencies:

   ```sh
   cd telegram-bridge
   npm install
   ```

2. Create `telegram-bridge/.env`:

   ```env
   TELEGRAM_BOT_TOKEN=your-bot-token
   HAIMAKER_API_KEY=your-haimaker-api-key
   # Optional: enables immediate registration for users with this code.
   REGISTRATION_PROMO_CODE=
   ```

3. Start the bot:

   ```sh
   npx tsx telegraf.ts
   ```

The bot uses an allowlist in `telegram-bridge/data/allowed-users.json`. Run
the approval command to approve pending users:

```sh
cd telegram-bridge
npm run approve-user
```

Do not commit `.env` or files under `telegram-bridge/data/`.

## Development

From `telegram-bridge/`:

```sh
# Run tests.
npm test

# Run an interactive lesson.
npm run lesson-repl -- 02-tapas-bar.md

# Run live lesson evaluation (requires configured Pi credentials).
npm run lesson-eval
```

## Further documentation

- [`telegram-bridge/README.md`](telegram-bridge/README.md) has full setup,
  access-control, command, analytics, and request-behavior details.
- [`telegram-bridge/doc/architecture.md`](telegram-bridge/doc/architecture.md)
  describes the runtime design and trust boundaries.
- [`agent/AGENTS.md`](agent/AGENTS.md) identifies the tutor configuration and
  lesson-authoring files.
