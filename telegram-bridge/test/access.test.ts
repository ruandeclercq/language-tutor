import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedUsers, sanitizeName } from "../access.js";

test("sanitizeName normalizes whitespace and removes control characters", () => {
  assert.equal(sanitizeName("  Ana\n\t\u0000 María  "), "Ana María");
});

test("sanitizeName rejects empty and overlong names", () => {
  assert.equal(sanitizeName(" \n\t"), null);
  assert.equal(sanitizeName("a".repeat(101)), null);
});

test("parseAllowedUsers returns users keyed by Telegram ID", () => {
  const users = parseAllowedUsers([
    { telegramUserId: 42, name: "Ana", approvedAt: "2026-07-15T00:00:00Z" },
  ]);

  assert.equal(users.get(42)?.name, "Ana");
});

test("parseAllowedUsers rejects malformed data", () => {
  assert.throws(() => parseAllowedUsers({ telegramUserId: 42 }));
  assert.throws(() => parseAllowedUsers([
    { telegramUserId: 42, name: "Ana", approvedAt: "not a date" },
  ]));
});
