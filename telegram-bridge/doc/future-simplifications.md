# Future simplifications

## Replace split busy flags with one state

`UserState` currently uses separate `processing` and `transcribing` flags.
Handler guards make them mutually exclusive, but two flags allow invalid
combinations in the type.

If this state changes again, consider replacing them with:

```ts
busy: "pi" | "voice" | null;
```

This would improve state clarity more than it would reduce line count. Defer
until another busy-state change makes the refactor worthwhile.
