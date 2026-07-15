# Telegram bridge

A small Telegram adapter for the local Pi coding agent. The bridge accepts
private-chat messages from approved Telegram users, forwards text to Pi, and
edits the Telegram placeholder with Pi's response.

## Requirements

- Node.js with npm
- A Telegram bot token from BotFather
- The sibling `../agent/` workspace, including its `lessons/` directory
- Pi authentication configured in the local environment

Install dependencies with:

```sh
npm install
```

## Configuration

Create a local `.env` file:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id
```

`TELEGRAM_ALLOWED_USER_ID` is used only to seed the file-based allowlist on
startup. The active allowlist is `data/allowed-users.json`; after it exists,
updates are authorized from that file and the file is reloaded for every
incoming update. If the environment variable is missing, the bridge starts
but warns and fails closed until the allowlist is populated manually.

Do not commit `.env` or the files under `data/`.

## Run

From this directory:

```sh
npx tsx telegraf.ts
```

The process validates the bot token, creates or seeds the allowlist when
possible, registers the Telegram command menu, and starts polling Telegram.
Stop it with `Ctrl-C`.

## Access control

Only private-chat updates from users in `data/allowed-users.json` reach the
Pi and tutoring handlers. Group and channel updates are ignored. Missing,
invalid, or unreadable allowlist data denies access.

The allowlist is a JSON array:

```json
[
  {
    "telegramUserId": 123456789,
    "name": "Example User",
    "approvedAt": "2026-07-15T17:00:00.000Z"
  }
]
```

To approve a user, add a record and wait for their next update. To remove
access, delete the record; the next update is denied.

Unapproved private users receive the private-access message. They can send
`/register`, then provide a name within 10 minutes. The sanitized request is
appended to `data/access-requests.jsonl` for manual review. Registration does
not approve the user automatically.

## Telegram commands

- `/start` resets the requesting user's Pi session and confirms that a fresh
  session was started.
- `/help` shows the welcome message and supported tutoring activities.
- `/lesson` lists Markdown lessons found in `../agent/lessons/`. Lesson titles
  come from a `title:` line in each file, falling back to the filename.
- `/register` starts the access request flow for an unapproved user. Approved
  users are told that they already have access.

Any other text message is sent to Pi. The first approved interaction from a
user also sends the welcome message.

## Request behavior

While Pi is processing a request, the bridge sends a placeholder and refreshes
Telegram's typing indicator every four seconds. A second request receives a
busy response. On success, the placeholder is edited with Pi's response; on
failure, it is edited with a user-facing error. Empty Pi responses get a
fallback message.

Lesson buttons use the same request path and start Pi with a prompt referring
to the selected lesson file.

## Data files

| File | Purpose |
| --- | --- |
| `data/allowed-users.json` | Approved Telegram users |
| `data/access-requests.jsonl` | Append-only access requests |

The data directory and request file are created automatically when needed.
Registration records contain the Telegram ID, optional username, sanitized
name, and UTC timestamp. The raw registration message is not stored.

## Current limitations

- Pi sessions are created lazily in memory, one per approved Telegram user.
- Processing state is per user, so different users can work concurrently.
- There is no global concurrency limit.
- Pi sessions are lost when the bridge restarts.
- The allowlist and registration files have no locking or administrative UI.
- There are currently no automated tests or type-check script in `package.json`.
