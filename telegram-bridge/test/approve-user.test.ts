import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { approveUser, listPendingRegistrations } from "../approve-user.js";

test("approval adds the user before sending the greeting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-bridge-"));
  const file = path.join(directory, "allowed-users.json");
  const user = { telegramUserId: 7, name: "Ana", approvedAt: "2026-07-16T00:00:00.000Z" };
  try {
    const added = await approveUser(file, user, async (userId, greeting) => {
      assert.equal(userId, 7);
      assert.equal(greeting, "Hola! You now have access to LanguageTutor. Send /start to begin.");
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [user]);
    });

    assert.equal(added, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending registrations keep the latest request per unapproved user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-bridge-"));
  const requestsFile = path.join(directory, "access-requests.jsonl");
  const allowedUsersFile = path.join(directory, "allowed-users.json");
  try {
    await writeFile(requestsFile, [
      '{"telegramUserId":1,"username":"ana","name":"Ana","requestedAt":"2026-07-16T00:00:00.000Z"}',
      '{"telegramUserId":2,"username":null,"name":"Ben","requestedAt":"2026-07-16T00:00:00.000Z"}',
      '{"telegramUserId":1,"username":"ana","name":"Ana Maria","requestedAt":"2026-07-17T00:00:00.000Z"}',
    ].join("\n"), "utf8");
    await writeFile(allowedUsersFile, JSON.stringify([
      { telegramUserId: 2, name: "Ben", approvedAt: "2026-07-16T01:00:00.000Z" },
    ]), "utf8");

    assert.deepEqual(await listPendingRegistrations(requestsFile, allowedUsersFile), [{
      telegramUserId: 1,
      username: "ana",
      name: "Ana Maria",
      requestedAt: "2026-07-17T00:00:00.000Z",
    }]);
    await writeFile(requestsFile, "not json", "utf8");
    await assert.rejects(listPendingRegistrations(requestsFile, allowedUsersFile), /line 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approval can resend the greeting without duplicating an existing user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-bridge-"));
  const file = path.join(directory, "allowed-users.json");
  const user = { telegramUserId: 7, name: "Ana", approvedAt: "2026-07-16T00:00:00.000Z" };
  try {
    await approveUser(file, user, async () => undefined);
    const added = await approveUser(file, user, async () => undefined);

    assert.equal(added, false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [user]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
