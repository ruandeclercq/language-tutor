import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeBot } from "../telegraf.js";

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

test("unapproved lesson callbacks are denied before state or Pi initialization", async () => {
  let sessions = 0;
  const { bot, calls, userStates } = testBot({
    token: "test-token",
    loadAllowedUsers: async () => new Map(),
    getLessons: async () => [{ filename: "intro.md", title: "Intro" }],
    createSession: async () => { sessions += 1; return session(); },
  });

  await bot.handleUpdate(lessonUpdate(9, "intro.md") as any);

  assert.equal(sessions, 0);
  assert.equal(userStates.size, 0);
  assert.ok(calls.some(({ method, payload }) => method === "sendMessage" &&
    payload.text.includes("This bot is private")));
  const menu = calls.find(({ method }) => method === "setMyCommands");
  assert.deepEqual(menu?.payload.commands.map((command: { command: string }) => command.command), ["register"]);
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
    createSession: async () => {
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
    { id: 1, prompt: "Start the lesson from lessons/one.md." },
    { id: 2, prompt: "Start the lesson from lessons/two.md." },
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
    createSession: async () => session(),
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
    createSession: async () => session(),
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

function session() {
  return {
    isStreaming: false,
    abort: async () => {},
    dispose: () => {},
    prompt: async () => {},
    subscribe: () => () => {},
  };
}
