# Structured command and error observability

## Summary

Introduce JSON-line operational logs that reveal command usage, access and
onboarding flow, lesson selection, and actionable error causes. Preserve
privacy by omitting user-authored text and command arguments by default.

## Implementation changes

- Add shared structured normal and error log helpers.
  - Normal events use stdout; errors use stderr.
  - Include timestamp, event, user ID, and Telegram `updateId` where available.
  - Include `requestId` on Pi-related events; failed Pi lifecycles emit a
    separate correlated error event.
- Emit one `command_invoked` record for every command attempt before
  authorization, including `/register`, unapproved or stale tutoring commands,
  and normalized unknown slash commands. Log command names only, never
  arguments.
- Emit onboarding and action records for access denial, registration started or
  submitted, lesson picker display with reason (`command` or `lesson_required`),
  valid lesson selection with validated filename, and invalid lesson selection
  without its untrusted callback payload.
- Replace generic error messages with contextual error records carrying a stable
  `operation` label. Serialize error name, message, stack, and up to two nested
  causes; cap each message and stack field at 5,000 characters. Normalize
  non-`Error` thrown values as `NonErrorThrown`.
- Add Telegraf's top-level error handler to log unhandled update failures and
  send a generic recovery message in private chats. Log process-level unhandled
  rejections and uncaught exceptions, then preserve fail-fast exit behavior. Do
  not add service or supervisor documentation in this change.
- Update existing Pi, Telegram, allowlist, command-menu, registration, session,
  and lesson failure paths to retain the original error object rather than
  discarding it.

## Test plan

- Assert command logs for recognized, unauthorized, and unknown commands;
  assert arguments and message text are absent.
- Assert access, registration, picker, valid-selection, and invalid-selection
  event records and metadata.
- Assert handled Pi and Telegram failures, fallback-message failures, unhandled
  handler failures, and nested or non-`Error` exceptions produce structured
  error records with correct correlation and operation labels.
- Preserve existing request-lifecycle assertions and verify error records do not
  expose prompt, response, registration-name, or raw invalid-callback content.
- Verify top-level failures still receive the generic private-chat recovery
  reply.

## Assumptions

- Standard output and error are the only log destinations; no external log
  service, persistence layer, or alerting is added.
- Error messages, stacks, and causes are intentionally logged by default; only
  their length is capped.
- A future service will restart the bot after fatal process errors; this change
  does not configure or document that service.
