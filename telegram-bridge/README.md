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
HAIMAKER_API_KEY=your-haimaker-api-key
# Optional: a reusable registration/promo code that grants immediate access.
REGISTRATION_PROMO_CODE=
POSTHOG_API_KEY=
# Set POSTHOG_HOST only to override the EU default:
# POSTHOG_HOST=https://eu.i.posthog.com
```

The bridge imports `dotenv/config` at startup, so `TELEGRAM_BOT_TOKEN` and
`HAIMAKER_API_KEY` are
loaded from this local `.env` file unless it is already provided by the
process environment. Keep the token secret and do not commit `.env`.

Product analytics use the `posthog-node` npm dependency, installed by `npm
install` after pulling these changes. Analytics are enabled only when
`POSTHOG_API_KEY` is set. The default PostHog ingestion host is EU Cloud at
`https://eu.i.posthog.com`; set `POSTHOG_HOST` only to override it. The bridge
sends explicit lesson-funnel and feature-use events with the Telegram numeric
user ID as the distinct ID. It does not send names, usernames, chats, message
text, voice transcripts, Pi prompts or responses, error events, session
recordings, or autocaptured events.

Captured events and their safe properties are:

- `bot_started` - no properties.
- `registration_started` - no properties.
- `registration_submitted` - no properties.
- `user_signed_up` - `signup_method`: `promo_code`.
- `lesson_picker_shown` - `reason`: `command`, `first_use`, or `completion`.
- `lesson_selected` - `lesson_filename`: selected Markdown lesson filename.
- `lesson_action_selected` - `action_type`: `prepare`, `summary`, or `start`.
- `lesson_started` - `lesson_filename`: started Markdown lesson filename.
- `lesson_completed` - `lesson_filename`; `duration_seconds`: non-negative
  whole seconds; `message_count`: non-negative accepted learner replies.
- `learner_message_submitted` - `input_type`: `text` or `voice`;
  `response_time_ms`: non-negative learner turnaround time when available;
  `input_length`: non-negative Unicode character count for text; or
  `voice_file_size_bytes`: declared voice-note size when available.

Properties never contain learner-authored content, voice transcripts, prompts,
or responses. `user_signed_up` currently covers immediate promo-code access;
manual approvals happen in the separate approval CLI and are not captured by
the bot's PostHog integration.

## Repository layout

| Path | Purpose |
| --- | --- |
| `telegraf.ts` | Telegram handlers and bridge lifecycle |
| `lesson-session.ts` | Pi session creation and prompt wrapper |
| `lesson-repl.ts` | Interactive lesson runner |
| `lesson-eval.ts` | Automated live lesson scenarios |
| `test/` | Bridge and lesson-evaluation tests |
| `../agent/.pi/SYSTEM.md` | Pi's tutor behavior prompt |
| `../agent/.pi/models.json` | Pi provider, model list, and default model |
| `../agent/.pi/settings.json` | Pi runtime settings and default model |
| `../agent/lessons/` | Markdown lesson files loaded by `/lesson` |
| `../agent/.pi/skills/lesson/SKILL.md` | Lesson and roleplay mechanics |

Pi model selection is configured in both `.pi/models.json` and
`.pi/settings.json`; keep their `defaultModel` values aligned. The current
default is `z-ai/glm-4.6` through Haimaker. The bridge does not set a separate
reasoning level; Pi uses the model/provider default unless one is selected in
the Pi client.

To temporarily include bounded prompt and response previews in Pi request
lifecycle logs, add this to `.env` and restart the bridge:

```env
TELEGRAM_DEBUG_LOG_CONTENT=1
```

This sensitive, debug-only mode is off by default. It logs up to 500 characters
of each prompt and response, so enable it only while debugging and remove the
setting afterward.

The active allowlist is `data/allowed-users.json`. Its modification timestamp
is checked for every incoming update, and the JSON is reparsed only when that
timestamp changes. If the file is missing or malformed, the bridge fails
closed until the allowlist is populated manually.

Do not commit `.env` or the files under `data/`.

## Run

From this directory:

```sh
npx tsx telegraf.ts
```

The process validates the bot token, registers the Telegram command menu, and
starts polling Telegram.
Stop it with `Ctrl-C`.

## Development

Run the test suite with:

```sh
npm test
```

Run the live lesson evaluation with the configured Pi model and API key:

```sh
npm run lesson-eval
```

Run an interactive lesson session:

```sh
npm run lesson-repl -- 02-tapas-bar.md
```

Type-check the bridge and tests with:

```sh
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck telegraf.ts access.ts test/access.test.ts test/telegraf.test.ts
```

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

Approve a registered user with the approval command rather than editing the
file directly. Run it without arguments to choose from the pending registered
users:

```sh
npm run approve-user
```

You can still approve a known user directly:

```sh
npm run approve-user -- <telegram-user-id> "Name from the access request"
```

It atomically adds a new user to the allowlist, then sends them `Hola!` with
instructions to use `/start`. If Telegram delivery fails, the command exits
with an error but the allowlist change remains; run the same command again to
resend the greeting without duplicating the user. To remove access, delete the
record; the next update is denied.

An unapproved user's first private interaction starts registration (and
`/register` restarts it) by asking whether they have a registration/promo code.
Entering a configured `REGISTRATION_PROMO_CODE` grants immediate access; five
incorrect attempts within 15 minutes lock further code attempts for 15 minutes.
Choosing no code asks for a name within the existing 10-minute registration
window. The sanitized request is appended to `data/access-requests.jsonl` for
manual review, and the user is asked to WhatsApp the bot owner on
`+27 66 118 6289`. Expired registration prompts and cached per-chat command-menu
state are removed during the 24-hour idle cleanup.

## Telegram commands

- `/start` resets the requesting user's Pi session, clears their lesson
  selection, shows the welcome message, and opens the lesson picker.
- `/help` shows the welcome message and supported tutoring activities.
- `/lesson` opens a picker of Markdown lessons found in `../agent/lessons/`.
  Lesson titles come from a `title:` line in each file, falling back to the
  filename. Choosing a lesson opens a launch screen with **Empezar**, **Ver 5
  resumen de la lección**, **Ver 5 frases útiles**, and **Volver**, rather than
  starting roleplay immediately.
- `/register` starts or restarts the registration flow for an unapproved user.
  Approved users are told that they already have access.

**Ver resumen de la lección** optionally requests a compact review of the
selected lesson. It covers the scenario and roles, key vocabulary, useful
phrases with English translations, taught grammar or patterns, and all examples
taught in the lesson. It uses only lesson material and does not start roleplay
or a quiz.

**Ver 5 frases útiles** shows five short Spanish phrases specific to the
selected lesson, each with a brief English meaning, without starting roleplay.
Later reviews ask Pi for phrases not shown in earlier reviews of that selected
lesson.
**Empezar** resets the session and starts the roleplay; the phrase option is no
longer available. Text and voice are treated as active lesson responses only
after the learner presses **Empezar**.

Any other text message or voice note requires an active lesson. If none has
been started, the bot shows the lesson picker instead of sending the message to
Pi. The first approved interaction from a user also sends the welcome message.
Voice notes are downloaded only into memory, transcribed by Haimaker's
`openai/gpt-4o-mini-transcribe` model, then handled exactly like text. The bot
does not force a transcription language. Voice notes are limited to five
minutes and 20 MB; audio is not retained after the request.
When Pi marks a lesson complete, the bridge removes the marker, shows the final
response, opens the lesson picker, and will not send subsequent messages to Pi
until the user selects another lesson. `/start` and selecting a lesson reset
the completion state.

## Request behavior

While Pi is processing a request, the bridge sends a placeholder and refreshes
Telegram's typing indicator every four seconds. Each user can have at most one
active request; a second text message, voice note, `/start`, `/lesson`, or
lesson button callback receives a busy response. A session reset triggered by `/start`
uses the same per-user busy guard but does not consume a global Pi request slot.
Across all users, at most 10 Pi-backed requests run concurrently. An 11th
request is immediately rejected with a service-busy response rather than
queued. On success, the placeholder is edited with Pi's response; on failure,
it is edited with a user-facing error. Request capacity, processing state,
typing intervals, and pending prompts are released after both success and
failure. Empty Pi responses get a fallback message.

Opening the `/lesson` menu itself does not consume global request capacity.
Choosing a lesson opens its launch screen; **Empezar** uses the same request
path and starts Pi with a prompt referring to the selected lesson file.

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
- At most 10 Pi-backed requests run concurrently across all users; excess
  requests are rejected rather than queued.
- Requests do not currently have a timeout or rate limiter.
- Pi sessions are lost when the bridge restarts.
- The allowlist and registration files have no locking or administrative UI.
