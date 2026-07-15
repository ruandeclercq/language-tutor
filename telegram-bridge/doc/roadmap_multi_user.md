# Multi-user Roadmap

## 1. Define user identity

Use `ctx.from.id` as the primary user key.

For group chats, decide later whether state belongs to the user or the chat.

## 2. Introduce per-user state

Replace global state with:

```ts
type UserState = {
  session: PiSession;
  pendingPrompt: Promise<void>;
  processing: boolean;
  welcomed: boolean;
};
```

Store states in:

```ts
Map<number, UserState>
```

## 3. Create sessions lazily

Create a Pi session only when a user first interacts. This avoids creating sessions for inactive users.

## 4. Route all requests through user state

Update `/start`, `/lesson`, text messages, busy checks, typing indicators, placeholder message IDs, and `promptPi` to use the requesting user’s state.

## 5. Isolate responses

Ensure every Pi event listener is attached to the correct user session and edits only that user’s Telegram message.

Test two users generating responses simultaneously.

## 6. Handle cleanup

Add session disposal, idle-session cleanup, safe reset behavior, cleanup after errors, and protection against stale events.

## 7. Decide workspace isolation

Initially, users may share the agent directory if Pi only maintains conversation state.

If Pi can modify files, create a separate workspace per user:

```text
agent/users/<telegram-user-id>/
```

## 8. Add persistence

If sessions must survive restarts, persist selected lesson, welcome status, session metadata, and possibly conversation history.

A database or small JSON store would work initially.

## 9. Add access and operational controls

Before supporting real users, add per-user authorization, rate limiting, request timeouts, maximum concurrent users, user-aware logging, and admin reset tools.

The first practical milestone is steps 1–5: independent conversational sessions and correct response routing.

## Agreed design decisions

### Chat scope and access

- Support private chats only; silently ignore group-chat updates.
- Use `ctx.from.id` as the user identity key.
- Allow access only to users listed in `data/allowed-users.json`.
- Reload the allowlist for each incoming update.
- Fail closed if the allowlist is missing or malformed.
- Remove `TELEGRAM_ALLOWED_USER_ID`; the file becomes the sole authority.
- Seed the current user as the first approved user.
- Store approved users as records with `telegramUserId`, `name`, and `approvedAt`.
- Git-ignore the live allowlist and registration data.

### Unapproved users and registration

- Unapproved users cannot reach Pi or tutoring features.
- `/start`, `/help`, and ordinary messages show a private-access welcome.
- `/lesson` also shows the private-access welcome instead of the lesson menu.
- `/register` asks only: “What is your name?”
- Store requests in `data/access-requests.jsonl` as append-only records containing:
  `telegramUserId`, `username`, sanitized `name`, and `requestedAt`.
- Do not store the raw registration message.
- Confirm successful registration without notifying an administrator automatically.
- Repeating `/register` restarts the name prompt.
- Pending registration state is in memory only and expires after 10 minutes.
- Approved users sending `/register` are told they already have access.
- Create the data directory and request file automatically when needed.

### Sessions and requests

- Keep one in-memory Pi session per approved user.
- `/start` resets only the requesting user’s session.
- Re-approval creates a fresh Pi session; never restore a session across an access gap.
- Do not persist Pi conversations across bridge restarts.
- Dispose sessions after 24 hours of inactivity.
- Block `/start`, `/lesson`, and ordinary messages while that user has an active request.
- Reject requests above the global limit of 10 concurrent Pi requests; never queue them.
- Let an in-flight request finish if access is later removed; deny subsequent updates.

### Pi capabilities and workspace

- Users share the existing `agent/` directory for lesson and skill content.
- Create read-only Pi sessions with only `read`, `grep`, `find`, and `ls` tools.
- Do not expose `bash`, `edit`, or `write` tools.
- Add per-user workspaces only if file editing becomes a future requirement.
