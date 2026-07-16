import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRegistrationRequest, createBridgeBot, readOnlyPiTools } from "../telegraf.js";

const approvedUser = (id: number) => new Map([[id, {
  telegramUserId: id,
  name: `User ${id}`,
  approvedAt: "2026-07-15T00:00:00Z",
}]]);

function messageUpdate(id: number, text: string) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      text,
      from: { id, is_bot: false, first_name: "Test" },
      chat: { id, type: "private" as const },
    },
  };
}

function lessonUpdate(id: number, filename: string) {
  return {
    update_id: id,
    callback_query: {
      id: `callback-${id}`,
      from: { id, is_bot: false, first_name: "Test" },
      data: `lesson:${filename}`,
      message: {
        message_id: id,
        date: 0,
        chat: { id, type: "private" as const },
      },
    },
  };
}

function testBot(options: Parameters<typeof createBridgeBot>[0]) {
  const bridge = createBridgeBot(options);
  const calls: Array<{ method: string; payload: any }> = [];
  let messageId = 100;
  (bridge.bot.telegram as any).callApi = async (method: string, payload: any) => {
    calls.push({ method, payload });
    return method === "sendMessage" ? { message_id: messageId++ } : true;
  };
  (bridge.bot as any).botInfo = { id: 1, is_bot: true, first_name: "Test", username: "test_bot" };
  (bridge.bot.context as any).telegram = bridge.bot.telegram;
  return { ...bridge, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Pi sessions receive only the read-only SDK tool allowlist", async () => {
  const configuredTools: Array<readonly string[]> = [];
  const { bot } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [],
    createPiSession: async (tools) => {
      configuredTools.push(tools);
      return session();
    },
  });

  await bot.handleUpdate(messageUpdate(1, "hola") as any);
  await tick();

  assert.deepEqual(readOnlyPiTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(configuredTools, [["read", "grep", "find", "ls"]]);
});

test("idle user states are disposed and removed by deterministic cleanup", async () => {
  let now = 0;
  let disposed = 0;
  const { bot, userStates, cleanupIdleUsers } = testBot({
    token: "test-token",
    now: () => now,
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [],
    createPiSession: async () => ({ ...session(), dispose: () => { disposed += 1; } }),
  });

  await bot.handleUpdate(messageUpdate(1, "hola") as any);
  await tick();
  now = 24 * 60 * 60 * 1000;
  cleanupIdleUsers();

  assert.equal(disposed, 1);
  assert.equal(userStates.has(1), false);
});

test("cleanup waits for an active Pi request to finish", async () => {
  let now = 0;
  let disposed = 0;
  const started = deferred();
  const finish = deferred();
  const { bot, userStates, cleanupIdleUsers } = testBot({
    token: "test-token",
    now: () => now,
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [],
    createPiSession: async () => ({
      ...session(),
      dispose: () => { disposed += 1; },
      prompt: async () => {
        started.resolve();
        await finish.promise;
      },
    }),
  });

  await bot.handleUpdate(messageUpdate(1, "hola") as any);
  await started.promise;
  now = 24 * 60 * 60 * 1000;
  cleanupIdleUsers();

  assert.equal(disposed, 0);
  assert.equal(userStates.has(1), true);
  finish.resolve();
  await userStates.get(1)?.pendingPrompt;
  cleanupIdleUsers();

  assert.equal(disposed, 1);
  assert.equal(userStates.has(1), false);
});

test("allowlist removal keeps active work, then requires a fresh session after reapproval", async () => {
  let allowed = true;
  let sessions = 0;
  let disposed = 0;
  const started = deferred();
  const finish = deferred();
  const { bot, userStates, calls } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => allowed ? approvedUser(1) : new Map(),
    getLessons: async () => [],
    createPiSession: async () => {
      sessions += 1;
      const firstSession = sessions === 1;
      return {
        ...session(),
        dispose: () => { disposed += 1; },
        prompt: async () => {
          if (firstSession) {
            started.resolve();
            await finish.promise;
          }
        },
      };
    },
  });

  await bot.handleUpdate(messageUpdate(1, "first") as any);
  await started.promise;
  allowed = false;
  await bot.handleUpdate(messageUpdate(1, "denied") as any);

  assert.equal(disposed, 0);
  assert.equal(userStates.has(1), true);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("This bot is private")));

  finish.resolve();
  await userStates.get(1)?.pendingPrompt;
  assert.equal(disposed, 1);
  assert.equal(userStates.has(1), false);

  allowed = true;
  await bot.handleUpdate(messageUpdate(1, "second") as any);
  await tick();
  assert.equal(sessions, 2);
});

test("unapproved lesson callbacks are denied before state or Pi initialization", async () => {
  let sessions = 0;
  const { bot, calls, userStates } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => new Map(),
    getLessons: async () => [{ filename: "intro.md", title: "Intro" }],
    createPiSession: async () => { sessions += 1; return session(); },
  });

  await bot.handleUpdate(lessonUpdate(9, "intro.md") as any);

  assert.equal(sessions, 0);
  assert.equal(userStates.size, 0);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("This bot is private")));
  const menu = calls.find(({ method }) => method === "setMyCommands");
  assert.deepEqual(menu?.payload.commands.map((command: { command: string }) => command.command), ["register"]);
});

test("group updates are ignored before allowlist, Pi, and reply handling", async () => {
  let allowlistLoads = 0;
  let sessions = 0;
  const { bot, calls } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => { allowlistLoads += 1; return approvedUser(1); },
    getLessons: async () => [],
    createPiSession: async () => { sessions += 1; return session(); },
  });
  const update = messageUpdate(1, "hola");
  (update.message.chat as any).type = "group";

  await bot.handleUpdate(update as any);

  assert.equal(allowlistLoads, 0);
  assert.equal(sessions, 0);
  assert.equal(calls.length, 0);
});

test("unapproved registration sanitizes and records a request without initializing Pi", async () => {
  const requests: Array<{ telegramUserId: number; username: string | null; name: string }> = [];
  let sessions = 0;
  const { bot, calls } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => new Map(),
    getLessons: async () => [],
    createPiSession: async () => { sessions += 1; return session(); },
    recordRegistration: async (request) => { requests.push(request); },
  });

  await bot.handleUpdate(messageUpdate(9, "/register") as any);
  const name = messageUpdate(9, "  Ana\u00a0Maria  ");
  name.update_id = 10;
  name.message.message_id = 10;
  await bot.handleUpdate(name as any);

  assert.deepEqual(requests.map(({ telegramUserId, username, name: recordedName }) =>
    ({ telegramUserId, username, name: recordedName })), [{ telegramUserId: 9, username: null, name: "Ana Maria" }]);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("WhatsApp me on +27 66 118 6289")));
  assert.equal(sessions, 0);
});

test("lesson callbacks use each requester's independent Pi session", async () => {
  const prompts: Array<{ id: number; prompt: string }> = [];
  const { bot, userStates, calls } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => new Map([...approvedUser(1), ...approvedUser(2)]),
    getLessons: async () => [
      { filename: "one.md", title: "One" },
      { filename: "two.md", title: "Two" },
    ],
    createPiSession: async () => {
      const id = prompts.length + 1;
      return { ...session(), prompt: async (prompt: string) => {
        prompts.push({ id, prompt });
      } };
    },
  });

  await bot.handleUpdate(lessonUpdate(1, "one.md") as any);
  await bot.handleUpdate(lessonUpdate(2, "two.md") as any);
  await tick();

  assert.deepEqual(prompts, [
    { id: 1, prompt: "/skill:lesson Start the lesson from lessons/one.md." },
    { id: 2, prompt: "/skill:lesson Start the lesson from lessons/two.md." },
  ]);
  assert.notEqual(userStates.get(1)?.session, userStates.get(2)?.session);
  assert.ok(calls.some(({ method, payload }) => method === "setMyCommands" &&
    payload.scope.type === "chat" && payload.commands.some((command: { command: string }) => command.command === "lesson")));
  await tick();
});

test("start, lesson, and text share a user's active-request busy guard", async () => {
  const { bot, calls, userStates } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [{ filename: "one.md", title: "One" }],
    createPiSession: async () => session(),
  });

  userStates.set(1, {
    processing: true,
    pendingPrompt: Promise.resolve(),
    welcomed: true,
    lastActivityAt: Date.now(),
  });
  await bot.handleUpdate(messageUpdate(1, "/start") as any);
  await bot.handleUpdate(messageUpdate(1, "/lesson") as any);
  await bot.handleUpdate(messageUpdate(1, "still here") as any);

  const busyReplies = calls.filter(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("still working on your previous request"));
  assert.equal(busyReplies.length, 3);
});

test("help marks the user welcomed and command-menu failures do not block it", async () => {
  const { bot, calls } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [],
    createPiSession: async () => session(),
  });
  const originalCallApi = (bot.telegram as any).callApi;
  (bot.telegram as any).callApi = async (method: string, payload: any) => {
    if (method === "setMyCommands") {
      throw new Error("Telegram unavailable");
    }
    return originalCallApi(method, payload);
  };

  await bot.handleUpdate(messageUpdate(1, "/help") as any);
  await bot.handleUpdate(messageUpdate(1, "hola") as any);
  await tick();

  const welcomes = calls.filter(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("Welcome!"));
  assert.equal(welcomes.length, 1);
});

test("registration requests append one sanitized JSONL record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-bridge-"));
  const file = path.join(directory, "access-requests.jsonl");
  try {
    await appendRegistrationRequest(file, {
      telegramUserId: 7,
      username: "ana",
      name: "Ana Maria",
      requestedAt: "2026-07-15T00:00:00.000Z",
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      telegramUserId: 7,
      username: "ana",
      name: "Ana Maria",
      requestedAt: "2026-07-15T00:00:00.000Z",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("start disposes the previous session and creates a fresh one", async () => {
  let created = 0;
  let disposed = 0;
  const { bot, userStates } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [],
    createPiSession: async () => {
      created += 1;
      return { ...session(), dispose: () => { disposed += 1; } };
    },
  });

  const firstStart = messageUpdate(1, "/start");
  (firstStart.message as any).entities = [{ offset: 0, length: 6, type: "bot_command" }];
  await bot.handleUpdate(firstStart as any);
  await userStates.get(1)?.pendingPrompt;
  const secondStart = messageUpdate(1, "/start");
  secondStart.update_id = 2;
  secondStart.message.message_id = 2;
  (secondStart.message as any).entities = [{ offset: 0, length: 6, type: "bot_command" }];
  await bot.handleUpdate(secondStart as any);

  assert.equal(created, 2);
  assert.equal(disposed, 1);
});

test("overlapping starts serialize session resets without using Pi capacity", async () => {
  const created = deferred();
  let sessions = 0;
  const { bot, calls, getActivePiRequests } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => approvedUser(1),
    getLessons: async () => [],
    createPiSession: async () => {
      sessions += 1;
      await created.promise;
      return session();
    },
  });

  const firstStart = messageUpdate(1, "/start");
  (firstStart.message as any).entities = [{ offset: 0, length: 6, type: "bot_command" }];
  const first = bot.handleUpdate(firstStart as any);
  await tick();
  const secondStart = messageUpdate(1, "/start");
  secondStart.update_id = 2;
  secondStart.message.message_id = 2;
  (secondStart.message as any).entities = [{ offset: 0, length: 6, type: "bot_command" }];
  await bot.handleUpdate(secondStart as any);

  assert.equal(getActivePiRequests(), 0);
  assert.equal(sessions, 1);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("still working on your previous request")));
  created.resolve();
  await first;
  assert.equal(sessions, 1);
});

test("the eleventh concurrent request is rejected and all successful requests release capacity", async () => {
  const finish = deferred();
  const { bot, userStates, calls, getActivePiRequests } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => new Map(Array.from({ length: 11 }, (_, index) =>
      [index + 1, { telegramUserId: index + 1, name: `User ${index + 1}`, approvedAt: "2026-07-15T00:00:00Z" }])),
    getLessons: async () => [],
    createPiSession: async () => ({ ...session(), prompt: async () => { await finish.promise; } }),
  });

  await Promise.all(Array.from({ length: 10 }, (_, index) => bot.handleUpdate(messageUpdate(index + 1, "hola") as any)));
  assert.equal(getActivePiRequests(), 10);
  await bot.handleUpdate(messageUpdate(11, "hola") as any);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" && payload.text.includes("service is busy")));

  finish.resolve();
  await Promise.all(Array.from({ length: 10 }, (_, index) => userStates.get(index + 1)?.pendingPrompt));
  assert.equal(getActivePiRequests(), 0);
});

for (const [name, createPiSession, failEdit] of [
  ["Pi failure", async () => ({ ...session(), prompt: async () => { throw new Error("Pi failed"); } }), false],
  ["Telegram edit failure", async () => session(), true],
  ["session creation failure", async () => { throw new Error("session failed"); }, false],
] as const) {
  test(`${name} releases processing state and request capacity`, async () => {
    const bridge = testBot({
      token: "test-token",
      loadAllowedUsers: async () => approvedUser(1),
      getLessons: async () => [],
      createPiSession,
    });
    if (failEdit) {
      const callApi = (bridge.bot.telegram as any).callApi;
      (bridge.bot.telegram as any).callApi = async (method: string, payload: any) => {
        if (method === "editMessageText") throw new Error("edit failed");
        return callApi(method, payload);
      };
    }
    await bridge.bot.handleUpdate(messageUpdate(1, "hola") as any);
    await bridge.userStates.get(1)?.pendingPrompt;
    assert.equal(bridge.userStates.get(1)?.processing, false);
    assert.equal(bridge.getActivePiRequests(), 0);
  });
}

test("placeholder failures emit a failed terminal lifecycle entry", async () => {
  const entries: string[] = [];
  const originalInfo = console.info;
  console.info = (entry: string) => { entries.push(entry); };
  try {
    const bridge = testBot({
      token: "test-token",
      loadAllowedUsers: async () => approvedUser(1),
      getLessons: async () => [],
      createPiSession: async () => session(),
    });
    bridge.userStates.set(1, {
      processing: false,
      pendingPrompt: Promise.resolve(),
      welcomed: true,
      lastActivityAt: Date.now(),
    });
    const callApi = (bridge.bot.telegram as any).callApi;
    bridge.bot.catch(() => {});
    (bridge.bot.telegram as any).callApi = async (method: string, payload: any) => {
      if (method === "sendMessage") throw new Error("send failed");
      return callApi(method, payload);
    };

    await bridge.bot.handleUpdate(messageUpdate(1, "hola") as any);
    const lifecycle = entries.map((entry) => JSON.parse(entry));
    assert.deepEqual(lifecycle.map(({ outcome }) => outcome), ["started", "failed"]);
    assert.equal(lifecycle[0].requestId, lifecycle[1].requestId);
    assert.equal(bridge.getActivePiRequests(), 0);
    assert.equal(bridge.userStates.get(1)?.processing, false);
  } finally {
    console.info = originalInfo;
  }
});

test("cleanup expires registration and command-menu bookkeeping", async () => {
  let now = 0;
  const requests: unknown[] = [];
  const { bot, cleanupIdleUsers, calls } = testBot({
    token: "test-token",
    now: () => now,
    loadAllowedUsers: async () => new Map(),
    getLessons: async () => [],
    createPiSession: async () => session(),
    recordRegistration: async (request) => { requests.push(request); },
  });

  await bot.handleUpdate(messageUpdate(9, "/register") as any);
  now = 24 * 60 * 60 * 1000;
  cleanupIdleUsers();
  const update = messageUpdate(10, "Ana");
  update.message.from.id = 9;
  update.message.chat.id = 9;
  await bot.handleUpdate(update as any);

  assert.deepEqual(requests, []);
  assert.equal(calls.filter(({ method }) => method === "setMyCommands").length, 2);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("This bot is private")));
});

test("request lifecycle logs are structured and omit message and registration text", async () => {
  const entries: string[] = [];
  const originalInfo = console.info;
  console.info = (entry: string) => { entries.push(entry); };
  try {
    const { bot } = testBot({
      token: "test-token",
      debugLogContent: false,
      loadAllowedUsers: async () => approvedUser(1),
      getLessons: async () => [],
      createPiSession: async () => session(),
    });
    await bot.handleUpdate(messageUpdate(1, "private message text") as any);
    await tick();
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const parsed = JSON.parse(entry);
      assert.equal(typeof parsed.timestamp, "string");
      assert.equal(Number.isNaN(Date.parse(parsed.timestamp)), false);
      assert.equal(parsed.userId, 1);
      assert.equal(typeof parsed.requestId, "string");
      assert.ok(["started", "succeeded"].includes(parsed.outcome));
      assert.equal(entry.includes("private message text"), false);
    }
  } finally {
    console.info = originalInfo;
  }
});

test("debug request logging includes bounded prompt and response previews", async () => {
  const entries: string[] = [];
  const originalInfo = console.info;
  console.info = (entry: string) => { entries.push(entry); };
  try {
    const response = "respuesta";
    const { bot } = testBot({
      token: "test-token",
      debugLogContent: true,
      loadAllowedUsers: async () => approvedUser(1),
      getLessons: async () => [],
      createPiSession: async () => ({
        ...session(),
        prompt: async () => {},
        subscribe: (listener: any) => {
          queueMicrotask(() => listener({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: response }] }],
          }));
          return () => {};
        },
      }),
    });
    await bot.handleUpdate(messageUpdate(1, "private message") as any);
    await tick();

    assert.equal(entries.length, 2);
    const [started, succeeded] = entries.map((entry) => JSON.parse(entry));
    assert.equal(Number.isNaN(Date.parse(started.timestamp)), false);
    assert.equal(Number.isNaN(Date.parse(succeeded.timestamp)), false);
    assert.equal(started.promptPreview, "private message");
    assert.equal(succeeded.responsePreview, response);
    assert.equal(started.requestId, succeeded.requestId);
  } finally {
    console.info = originalInfo;
  }
});

function session() {
  return {
    isStreaming: false,
    abort: async () => {},
    dispose: () => {},
    prompt: async () => {},
    subscribe: () => () => {},
  };
}
