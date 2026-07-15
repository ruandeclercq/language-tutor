# Telegram bridge architecture

This document describes the implementation in `telegraf.ts`.

## Purpose and boundary

The bridge is a polling Telegram adapter around the local Pi coding-agent
session. It translates Telegram updates into Pi prompts and translates Pi
responses into Telegram replies.

The bridge owns:

- Telegram authentication and polling through Telegraf.
- Private-chat access control.
- Registration request collection.
- One in-memory Pi session per approved Telegram user.
- Lesson discovery and lesson-selection callbacks.
- Telegram placeholders, typing indicators, and response edits.

The bridge does not own:

- Pi authentication or model selection. Those are provided by Pi's local
  `AuthStorage` and `ModelRegistry`.
- Lesson authoring. Lessons are read from the sibling `../agent/lessons/`
  directory.
- Manual approval decisions. An operator edits the allowlist directly.
- Persistent conversation history. Pi sessions disappear when the process
  exits.

## Runtime topology

```text
Telegram
   |
   v
Telegraf polling
   |
   v
Authorization middleware
   |-- non-private chat -> ignore
   |-- unapproved user -> access message or registration flow
   '-- approved user -> command/message handlers
                         |
                         +--> lesson discovery -> inline callback
                         |
                         '--> UserState -> Pi session -> response edit

Filesystem:
  data/allowed-users.json      allowlist, timestamp checked on every update
  data/access-requests.jsonl   append-only registration requests
  ../agent/lessons/*.md        lesson catalogue
  ../agent/                   Pi session working directory
```

There is no database, HTTP server, queue, or separate worker process.

## Execution and threading model

The bridge runs on Node.js's single event loop. It does not use worker
threads, child processes, or OS-thread-per-request execution.

Telegraf dispatches Telegram updates to asynchronous handlers. While a handler
awaits Telegram or Pi I/O, the event loop can dispatch other updates. This
allows different users to process requests concurrently, but JavaScript
callbacks themselves do not execute in parallel.

Each approved user has independent request state and a Pi session. A user's
`processing` flag rejects a second text message, `/start`, `/lesson`, or lesson
button callback from that user with a busy response. It also serializes
`/start` session resets, without consuming a global Pi request slot. Users do
not block one another, subject to a global limit of 10 active Pi-backed
requests. The 11th request receives a service-busy response immediately and is
not queued. Typing indicators run on per-request timers and are cleared when
the request settles.

There is no global request queue. Opening the `/lesson` menu does not consume
global request capacity. State changes can interleave at `await` points, so
handlers must keep state user-scoped and clean up their own pending work.

## Startup

Module initialization performs these steps in order:

1. Import `dotenv/config`, which loads variables from the local `.env` file
   into the process environment, then require `TELEGRAM_BOT_TOKEN`.
2. Create the Telegraf bot and Pi authentication/model helpers.
3. Define the access-control and Telegram handlers.
4. Register `/start`, `/help`, and `/register` in Telegram's command menu.
5. Start Telegram polling with `bot.launch()`.

The bot token is configuration secret material. It is supplied through the
process environment, normally via the uncommitted local `.env` file, and is
never stored in the repository's data files.

Pi sessions are lazy: a `UserState` is created on the first approved update,
but its Pi session is created only when that user sends a prompt or starts a
lesson. `/start` creates a replacement session immediately.

## Update flow

In Telegram terminology, an **update** is one incoming event delivered to the
bot, such as a text message, command, or inline-keyboard callback query.

Every update passes through the authorization middleware:

1. Group and channel updates return without calling the next handler.
2. For private updates, the allowlist timestamp is checked; the JSON is
   reparsed only when the timestamp differs from the cached value.
3. Invalid or unreadable allowlist data produces an empty allowlist, so access
   fails closed.
4. `/register` is handled before the normal authorization check.
5. A pending registration accepts one non-command text message, sanitizes it,
   appends a JSONL record, and expires after ten minutes. Expired registrations
   are removed by the 24-hour idle cleanup even if the user never returns.
6. Unapproved users receive the private-access message and never reach Pi.
7. Approved users continue to the command or message handler.

The primary identity key is `ctx.from.id`. Telegram chat IDs are used only as
the destination for replies and typing actions.

## Per-user state

Approved users are mapped to this in-memory state:

```ts
type UserState = {
  session?: PiSession;
  pendingPrompt: Promise<void>;
  processing: boolean;
  welcomed: boolean;
  lastActivityAt: number;
  discardWhenIdle?: boolean;
};
```

`userStates` is a `Map<number, UserState>` keyed by Telegram user ID.

- `session` holds that user's Pi conversation.
- `pendingPrompt` represents the active request and its cleanup path.
- `processing` rejects another request from the same user.
- `welcomed` prevents repeated welcome messages during one process lifetime.
- `lastActivityAt` supports disposal of inactive sessions after 24 hours.
- `discardWhenIdle` defers disposal until an in-flight request completes after
  the user loses allowlist access.

Different users can create sessions and process requests concurrently. A
single user has at most one active request or session reset. `/start` is
rejected while that user is processing; otherwise it marks the user busy,
aborts a streaming session if necessary, disposes it, and creates a fresh
session. The reset is not a Pi-backed request and does not use global capacity.

## Pi interaction

`promptPi(session, prompt)` subscribes to the supplied user's Pi session,
starts one prompt, and collects text from the final assistant message. The
subscription is removed when the prompt settles. Pi request lifecycle events
are logged with user and request IDs. By default they omit message text and
responses. Setting `TELEGRAM_DEBUG_LOG_CONTENT=1` adds bounded, 500-character
prompt and response previews for temporary debugging and should be treated as
sensitive logging.

Text messages and lesson selections follow the same lifecycle:

1. Acquire global request capacity and mark the user's state as processing.
2. Send a Telegram placeholder.
3. Start a four-second typing-indicator interval.
4. Prompt that user's Pi session.
5. Edit the placeholder with the response.
6. On failure, edit the placeholder with a generic error.
7. Clear the interval, release the pending prompt and global capacity, and
   reset the user's processing state.

The lesson handler first re-reads the lesson directory and validates the
callback filename against the current catalogue. It invokes Pi's
`/skill:lesson` command with `Start the lesson from lessons/<filename>.`.

## Persistence and trust boundaries

`data/allowed-users.json` is the approval authority. It is trusted operator
input. Its modification timestamp is checked for every update, and the JSON
is reparsed only when that timestamp changes, so manual changes take effect
without restarting the bridge.

`data/access-requests.jsonl` is append-only application output. It stores the
Telegram ID, optional username, sanitized name, and UTC request timestamp.
Registration alone does not grant access.

Pi and all users share the same `../agent/` working directory, but sessions
receive only the read-only `read`, `grep`, `find`, and `ls` tools.

## Failure and concurrency model

- Missing bot-token configuration stops startup.
- Missing or malformed allowlist data denies access rather than granting it.
- A Pi failure is converted into a Telegram error for the originating user.
- A Telegram placeholder failure resets that user's processing state and
  propagates the handler error to Telegraf.
- A second text message, `/start`, `/lesson`, or lesson-button callback from a
  user with an active request receives a busy message.
- The 11th active Pi-backed request receives a service-busy message and is not
  queued; capacity, user processing state, typing intervals, and pending
  prompts are released after success and failure.
- There is currently no request timeout or rate limiter.
- In-memory state and Pi sessions are lost on restart.
- Every Pi-backed request that logs `started` logs exactly one terminal
  `succeeded` or `failed` event, including placeholder-send failures.
- Pi-backed requests emit JSON lifecycle logs with `userId`, `requestId`, and
  outcome. Message text, Pi responses, and registration names are omitted by
  default; `TELEGRAM_DEBUG_LOG_CONTENT=1` adds bounded prompt/response previews.
- Cached per-chat command-menu configuration is retained for 24 hours of
  inactivity, then removed with expired registration prompts during idle
  cleanup. A later update configures that chat's menu again.

Update this document whenever the runtime architecture changes.
