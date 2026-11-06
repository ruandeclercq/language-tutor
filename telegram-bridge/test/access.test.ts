import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { approveUser } from "../approve-user.js";
import { createAccessGate, parseAllowedUsers, sanitizeName } from "../access.js";

const approved = new Map([[42, { telegramUserId: 42, name: "Ana", approvedAt: "2026-07-15T00:00:00Z" }]]);

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

test("access gate records a sanitized registration", async () => {
  const records: unknown[] = [];
  const gate = createAccessGate({ loadAllowedUsers: async () => new Map(), now: () => 1_000, recordRegistration: async (r) => { records.push(r); } });
  assert.deepEqual(await gate.decide({ userId: 7, registerCommand: true }), { kind: "registration-prompt" });
  assert.deepEqual(await gate.decide({ userId: 7, text: "no", registerCommand: false }), { kind: "registration-name-prompt" });
  assert.deepEqual(await gate.decide({ userId: 7, username: "ana", text: " Ana\n María ", registerCommand: false }), { kind: "registration-recorded" });
  assert.equal((records[0] as { name: string }).name, "Ana María");
});

test("access gate rejects invalid and expired registrations", async () => {
  let clock = 0;
  const gate = createAccessGate({ loadAllowedUsers: async () => new Map(), now: () => clock, recordRegistration: async () => {} });
  await gate.decide({ userId: 7, registerCommand: true });
  await gate.decide({ userId: 7, text: "no", registerCommand: false });
  assert.deepEqual(await gate.decide({ userId: 7, text: "   ", registerCommand: false }), { kind: "invalid-registration" });
  clock = 10 * 60 * 1000;
  assert.deepEqual(await gate.decide({ userId: 7, text: "Ana", registerCommand: false }), { kind: "registration-prompt" });
});

test("approved users cannot register again", async () => {
  const gate = createAccessGate({ loadAllowedUsers: async () => approved, recordRegistration: async () => {} });
  assert.deepEqual(await gate.decide({ userId: 42, registerCommand: true }), { kind: "already-approved" });
});

test("a valid promo code persists an approved user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-bridge-"));
  const filePath = path.join(directory, "allowed-users.json");
  const gate = createAccessGate({
    loadAllowedUsers: async () => new Map(),
    recordRegistration: async () => {},
    promoCode: "hola-maryanne",
    approveUser: async (user) => { await approveUser(filePath, user, async () => {}); },
    now: () => 1_000,
  });
  try {
    await gate.decide({ userId: 7, registerCommand: false });
    await gate.decide({ userId: 7, text: "sí", registerCommand: false });
    assert.deepEqual(await gate.decide({ userId: 7, name: " Ana ", text: " HOLA-MARYANNE ", registerCommand: false }), { kind: "promo-approved" });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), [{
      telegramUserId: 7,
      name: "Ana",
      approvedAt: "1970-01-01T00:00:01.000Z",
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("five invalid promo attempts lock and unlock after fifteen minutes", async () => {
  let clock = 0;
  const gate = createAccessGate({
    loadAllowedUsers: async () => new Map(),
    recordRegistration: async () => {},
    promoCode: "correct",
    now: () => clock,
  });
  await gate.decide({ userId: 7, registerCommand: false });
  await gate.decide({ userId: 7, text: "sí", registerCommand: false });
  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.deepEqual(await gate.decide({ userId: 7, text: "wrong", registerCommand: false }), { kind: "invalid-promo-code" });
  }
  assert.deepEqual(await gate.decide({ userId: 7, text: "wrong", registerCommand: false }), { kind: "promo-locked" });
  clock = 15 * 60 * 1000;
  assert.deepEqual(await gate.decide({ userId: 7, text: "wrong", registerCommand: false }), { kind: "registration-prompt" });
  assert.deepEqual(await gate.decide({ userId: 7, text: "sí", registerCommand: false }), { kind: "promo-code-prompt" });
  assert.deepEqual(await gate.decide({ userId: 7, text: "wrong", registerCommand: false }), { kind: "invalid-promo-code" });
});
