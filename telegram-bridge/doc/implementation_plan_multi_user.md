# Multi-user Implementation Plan

The slices below are intentionally broad enough to deliver working behavior at each step. Complete and verify each slice before starting the next.

## Slice 1: File-based access and registration

Make access control independent of the current single-user environment variable.

Work items:

- Add `data/allowed-users.json` and seed the current user.
- Add `data/access-requests.jsonl` creation and append support.
- Add a small data-access module for loading the allowlist and appending requests.
- Remove `TELEGRAM_ALLOWED_USER_ID`.
- Restrict the bot to private chats.
- Handle unapproved `/start`, `/help`, and ordinary messages with the private-access welcome.
- Implement `/register` as a one-step name flow.
- Sanitize and validate the name, including the 10-minute pending-registration expiry.
- Keep `/register` available to approved users but respond that they already have access.
- Add the new files to `.gitignore`.

Acceptance criteria:

- An approved user can use the bot without the environment variable.
- An unapproved user cannot reach Pi.
- A registration creates one JSONL record containing the Telegram ID, username, sanitized name, and UTC timestamp.
- Missing request data files are created automatically.
- Missing or malformed allowlist data fails closed.

## Slice 2: Per-user Pi sessions

Replace global Pi state with independent lazy-created state for each approved user.

Work items:

- Introduce `Map<number, UserState>` keyed by `ctx.from.id`.
- Move the Pi session, pending request, processing state, welcome state, and activity timestamp into `UserState`.
- Refactor `promptPi` to receive an explicit user session.
- Create sessions lazily with `SessionManager.inMemory(...)`.
- Make `/start` reset only the requesting user’s session.
- Ensure session creation failures return a user-facing error without affecting other users.
- Preserve the existing lesson, welcome, placeholder, and final-edit behavior for one user.

Acceptance criteria:

- Two users have separate Pi conversation histories.
- One user’s `/start` does not reset another user’s session.
- A Pi failure in one session does not change another user’s processing state.
- Restarting the bridge starts fresh Pi sessions.

## Slice 3: Concurrent request control

Make request handling safe and predictable across users.

Work items:

- Keep one active request per user.
- Reject a second message, `/start`, or `/lesson` from that user while their request is running.
- Add a global concurrency counter or semaphore with a limit of 10.
- Reject requests above the global limit immediately; never queue them.
- Ensure every request owns its Telegram placeholder message, typing interval, and cleanup path.
- Ensure Pi events can only resolve and edit the originating user’s response.

Acceptance criteria:

- A second request from the same user receives the busy message and is not sent to Pi.
- Requests from different users can run concurrently.
- The 11th active request receives a service-busy response.
- All counters, locks, intervals, and processing flags are released after success and failure.

## Slice 4: Per-user lesson and command flow

Complete the migration of the existing Telegram features to user-scoped state.

Work items:

- Make `/lesson` use the requesting user’s processing state and Pi session.
- Keep lesson discovery based on `agent/lessons/*.md`.
- Make lesson selection start the correct user’s session with the selected filename.
- Make `/help` and welcome behavior user-scoped.
- Ensure unapproved callback queries cannot start lessons.
- Add the approved-user command menu without exposing tutoring commands as an access bypass.

Acceptance criteria:

- User A selecting a lesson never changes User B’s active lesson.
- An unapproved user cannot start a lesson through an old or forged callback button.
- `/start`, `/lesson`, and ordinary messages share the same per-user busy behavior.

## Slice 5: Read-only Pi sessions and lifecycle cleanup

Make the shared workspace safe for multiple users and bound memory usage.

Work items:

- Create sessions with only `read`, `grep`, `find`, and `ls` tools.
- Exclude `bash`, `edit`, and `write` tools.
- Track each user’s last activity time.
- Dispose and remove sessions after 24 hours of inactivity.
- Do not dispose a session while it has an active request.
- If a user is removed from the allowlist, allow an in-flight request to finish and deny later updates.
- If the user is approved again, create a fresh session.

Acceptance criteria:

- Pi cannot modify the shared `agent/` directory through its available tools.
- Idle sessions are eventually removed.
- Active requests are never abandoned by idle cleanup.
- Access removal takes effect on the next incoming update.

## Slice 6: Verification and operational hardening

Validate the multi-user behavior under realistic failure and concurrency conditions.

Work items:

- Add tests for allowlist parsing, fail-closed behavior, registration sanitization, and JSONL appends.
- Add tests for private-chat gating and unapproved-user flows.
- Add tests for per-user session isolation and `/start` reset behavior.
- Add tests for same-user rejection and the global limit of 10.
- Add tests for cleanup after Pi success, Pi failure, Telegram edit failure, and session creation failure.
- Add structured logs containing user ID, request ID, and event outcome without logging registration input unnecessarily.
- Document manual approval: add a user record to `data/allowed-users.json` and let the next update reload it.
- Run a two-user manual Telegram test before enabling additional users.

Acceptance criteria:

- The bridge passes type checking and automated tests.
- Two simultaneous users can complete independent lesson interactions.
- No personal data files are committed.
- Operational failures leave no stuck processing state or orphaned typing interval.

## Recommended delivery order

Implement and verify Slices 1–3 first. They establish access control, session isolation, and concurrency boundaries. Then complete the existing lesson flow in Slice 4, followed by tool restrictions and cleanup in Slice 5. Slice 6 is the release gate before allowing more users.
