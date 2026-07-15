import "dotenv/config";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { Markup } from "telegraf";
import { parseAllowedUsers, sanitizeName, type AllowedUser } from "./access.js";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = "../agent/";
const lessonsDirectory = path.resolve(cwd, "lessons");
const dataDirectory = path.resolve("data");
const allowedUsersPath = path.join(dataDirectory, "allowed-users.json");
const accessRequestsPath = path.join(dataDirectory, "access-requests.jsonl");
export const readOnlyPiTools = ["read", "grep", "find", "ls"] as const;
const idleSessionMs = 24 * 60 * 60 * 1000;
const debugContentPreviewLength = 500;

type PiSession = Pick<Awaited<ReturnType<typeof createAgentSession>>["session"],
  "isStreaming" | "abort" | "dispose" | "prompt" | "subscribe">;
type PiTool = typeof readOnlyPiTools[number];

export type RegistrationRequest = {
  telegramUserId: number;
  username: string | null;
  name: string;
  requestedAt: string;
};

export async function appendRegistrationRequest(filePath: string, request: RegistrationRequest) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(request)}\n`, "utf8");
}

type BridgeOptions = {
  token: string;
  loadAllowedUsers?: () => Promise<Map<number, AllowedUser>>;
  getLessons?: () => Promise<Array<{ filename: string; title: string }>>;
  createPiSession?: (tools: readonly PiTool[]) => Promise<PiSession>;
  recordRegistration?: (request: RegistrationRequest) => Promise<void>;
  now?: () => number;
  debugLogContent?: boolean;
};

export function createBridgeBot(options: BridgeOptions) {
  const bot = new Telegraf(options.token);
  const now = options.now ?? Date.now;
  const debugLogContent = options.debugLogContent ?? process.env.TELEGRAM_DEBUG_LOG_CONTENT === "1";

  const privateAccessMessage =
    "This bot is private. Access requests are reviewed manually. Use /register to request access.";
  const registrationExpiryMs = 10 * 60 * 1000;
  const pendingRegistrations = new Map<number, number>();
  const maxActivePiRequests = 10;
  let activePiRequests = 0;
  const busyMessage = "⏳ I'm still working on your previous request.\nPlease wait for it to finish.";
  const serviceBusyMessage = "The service is busy. Please try again shortly.";
  let cachedAllowedUsers: Map<number, AllowedUser> | undefined;
  let cachedAllowedUsersMtimeMs: number | null | undefined;

  async function loadAllowedUsers(): Promise<Map<number, AllowedUser>> {
    let mtimeMs: number;
    try {
      ({ mtimeMs } = await stat(allowedUsersPath));
    } catch {
      console.error("Allowlist unavailable; denying access.");
      cachedAllowedUsers = new Map();
      cachedAllowedUsersMtimeMs = null;
      return cachedAllowedUsers;
    }

    if (cachedAllowedUsers !== undefined && cachedAllowedUsersMtimeMs === mtimeMs) {
      return cachedAllowedUsers;
    }

    try {
      const parsed: unknown = JSON.parse(await readFile(allowedUsersPath, "utf8"));
      cachedAllowedUsers = parseAllowedUsers(parsed);
      cachedAllowedUsersMtimeMs = mtimeMs;
      return cachedAllowedUsers;
    } catch {
      console.error("Allowlist unavailable; denying access.");
      cachedAllowedUsers = new Map();
      cachedAllowedUsersMtimeMs = mtimeMs;
      return cachedAllowedUsers;
    }
  }

  const findAllowedUsers = options.loadAllowedUsers ?? loadAllowedUsers;

  async function recordRegistration(ctx: { from?: { id: number; username?: string }; }, name: string) {
    const request: RegistrationRequest = {
      telegramUserId: ctx.from!.id,
      username: ctx.from!.username ?? null,
      name,
      requestedAt: new Date().toISOString(),
    };
    await (options.recordRegistration ?? ((entry) => appendRegistrationRequest(accessRequestsPath, entry)))(request);
  }

  // Content previews are opt-in and bounded so normal operational logs stay private and compact.
  const contentPreview = (content: string) => content
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, debugContentPreviewLength);

  const logRequest = (
    userId: number,
    requestId: string,
    outcome: "started" | "succeeded" | "failed",
    content?: { prompt?: string; response?: string },
  ) => {
    const entry = {
      timestamp: new Date().toISOString(),
      event: "pi_request",
      userId,
      requestId,
      outcome,
    } as Record<string, string | number>;
    if (debugLogContent && content?.prompt !== undefined) entry.promptPreview = contentPreview(content.prompt);
    if (debugLogContent && content?.response !== undefined) entry.responsePreview = contentPreview(content.response);
    console.info(JSON.stringify(entry));
  };

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const createPiSession = (tools: readonly PiTool[]) =>
    createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      authStorage,
      modelRegistry,
      tools: [...tools],
    }).then(({ session }) => session);

  const sessionFactory = options.createPiSession ?? createPiSession;
  type UserState = {
    session?: PiSession;
    pendingPrompt: Promise<void>;
    processing: boolean;
    welcomed: boolean;
    lastActivityAt: number;
    discardWhenIdle?: boolean;
  };

  const userStates = new Map<number, UserState>();

  function getUserState(userId: number): UserState {
    let state = userStates.get(userId);
    if (!state) {
      state = {
        pendingPrompt: Promise.resolve(),
        processing: false,
        welcomed: false,
        lastActivityAt: now(),
      };
      userStates.set(userId, state);
    }
    state.lastActivityAt = now();
    return state;
  }

  function disposeUserState(userId: number, state: UserState) {
    if (userStates.get(userId) !== state) {
      return;
    }
    userStates.delete(userId);
    try {
      state.session?.dispose();
    } catch {
      console.error("Session disposal failed.");
    }
  }

  function cleanupIdleUsers() {
    const cutoff = now() - idleSessionMs;
    for (const [userId, state] of userStates) {
      if (!state.processing && state.lastActivityAt <= cutoff) {
        disposeUserState(userId, state);
      }
    }
    for (const [userId, pendingUntil] of pendingRegistrations) {
      if (pendingUntil <= now()) {
        pendingRegistrations.delete(userId);
      }
    }
    for (const [userId, configuration] of configuredCommandMenus) {
      if (configuration.lastActivityAt <= cutoff) {
        configuredCommandMenus.delete(userId);
      }
    }
  }

  const cleanupInterval = setInterval(cleanupIdleUsers, idleSessionMs);
  cleanupInterval.unref();

  // Acquisition is synchronous so two updates cannot observe the same available slot.
  function acquirePiRequest(state: UserState): boolean {
    if (state.processing || activePiRequests >= maxActivePiRequests) {
      return false;
    }
    state.processing = true;
    activePiRequests += 1;
    return true;
  }

  // Release exactly the resources acquired for one Pi-backed request.
  function releasePiRequest(userId: number, state: UserState) {
    state.processing = false;
    state.pendingPrompt = Promise.resolve();
    activePiRequests -= 1;
    if (state.discardWhenIdle) {
      disposeUserState(userId, state);
    }
  }

  async function getSession(state: UserState): Promise<PiSession> {
    return state.session ??= await sessionFactory(readOnlyPiTools);
  }

  async function resetSession(userId: number, state: UserState) {
    state.processing = true;
    try {
      const previousSession = state.session;
      state.session = undefined;

      if (previousSession?.isStreaming) {
        await previousSession.abort();
      }

      previousSession?.dispose();
      const replacementSession = await sessionFactory(readOnlyPiTools);
      if (userStates.get(userId) === state) {
        state.session = replacementSession;
      } else {
        replacementSession.dispose();
      }
    } finally {
      state.processing = false;
      state.pendingPrompt = Promise.resolve();
      if (state.discardWhenIdle) {
        disposeUserState(userId, state);
      }
    }
  }

  const promptPi = async (session: PiSession, prompt: string): Promise<string> => {
    let responseText = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "agent_end") {
        return;
      }

      const response = event.messages.at(-1);
      if (response?.role !== "assistant") {
        return;
      }

      for (const part of response.content) {
        if (part.type === "text") {
          responseText += part.text;
        }
      }

      responseText = responseText.trim();
    });

    try {
      await session.prompt(prompt);
      return responseText;
    } finally {
      unsubscribe();
    }
  };

  const welcomeMessage = `👋 Welcome!

  I'm here to help you practice Spanish.

  You can:
  - Practice conversation
  - Ask grammar questions
  - Translate words and phrases
  - Get corrections while you chat

  Use /lesson to browse available lessons or simply start chatting.`;

  const getLessons = async () => {
    const filenames = (await readdir(lessonsDirectory))
      .filter((filename) => filename.endsWith(".md"))
      .sort();

    return Promise.all(filenames.map(async (filename) => {
      const contents = await readFile(path.join(lessonsDirectory, filename), "utf8");
      const title = contents.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? filename;
      return { filename, title };
    }));
  };

  const listLessons = options.getLessons ?? getLessons;

  function isCommand(text: string | undefined, command: string) {
    return text !== undefined && text.trim().match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, "i")) !== null;
  }

  // Authorization is checked for every update so manual allowlist changes take effect immediately.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) {
      return;
    }

    const allowedUsers = await findAllowedUsers();
    const approved = allowedUsers.has(ctx.from.id);
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;

    // Telegram command scopes are per chat, so tutoring commands are only shown
    // after an approved user sends an update. Authorization below remains the
    // authority for every update, including stale command-menu entries.
    await configureCommandMenu(ctx.from.id, approved).catch(() =>
      console.error("Command menu configuration failed."));

    if (!approved) {
      const state = userStates.get(ctx.from.id);
      if (state) {
        if (state.processing) {
          state.discardWhenIdle = true;
        } else {
          disposeUserState(ctx.from.id, state);
        }
      }
    }

    if (isCommand(text, "register")) {
      if (approved) {
        await ctx.reply("You already have access.");
      } else {
        pendingRegistrations.set(ctx.from.id, now() + registrationExpiryMs);
        await ctx.reply("What is your name?");
      }
      return;
    }

    const pendingUntil = pendingRegistrations.get(ctx.from.id);
    if (pendingUntil !== undefined) {
      if (pendingUntil <= now()) {
        pendingRegistrations.delete(ctx.from.id);
      } else if (typeof text === "string" && !text.trim().startsWith("/")) {
        const name = sanitizeName(text);
        if (!name) {
          await ctx.reply("Please provide a valid name (up to 100 characters).");
          return;
        }
        await recordRegistration(ctx, name);
        pendingRegistrations.delete(ctx.from.id);
        await ctx.reply("Your access request has been recorded for manual review.");
        return;
      }
    }

    if (!approved) {
      await ctx.reply(privateAccessMessage);
      return;
    }

    const state = userStates.get(ctx.from.id);
    if (state) {
      state.lastActivityAt = now();
    }

    return next();
  });

  const publicCommands = [
    { command: "register", description: "Request private access" },
  ];
  const approvedCommands = [
    { command: "start", description: "Start the bot" },
    { command: "help", description: "Show help" },
    { command: "lesson", description: "Browse lessons" },
    ...publicCommands,
  ];
  const configuredCommandMenus = new Map<number, { approved: boolean; lastActivityAt: number }>();

  async function configureCommandMenu(userId: number, approved: boolean) {
    const configuration = configuredCommandMenus.get(userId);
    if (configuration?.approved === approved) {
      configuration.lastActivityAt = now();
      return;
    }
    await bot.telegram.setMyCommands(
      approved ? approvedCommands : publicCommands,
      { scope: { type: "chat", chat_id: userId } },
    );
    configuredCommandMenus.set(userId, { approved, lastActivityAt: now() });
  }

  bot.start(async (ctx) => {
    const state = getUserState(ctx.from.id);
    if (state.processing) {
      await ctx.reply(busyMessage);
      return;
    }

    try {
      await resetSession(ctx.from.id, state);
      state.welcomed = true;
      await ctx.reply(welcomeMessage);
    } catch {
      console.error("Session reset failed.");
      await ctx.reply("Sorry, I couldn't start a fresh session. Please try again.");
    }
  });
  bot.help((ctx) => {
    getUserState(ctx.from.id).welcomed = true;
    return ctx.reply(welcomeMessage);
  });

  bot.command("lesson", async (ctx) => {
    const state = getUserState(ctx.from.id);
    if (state.processing) {
      await ctx.reply(busyMessage);
      return;
    }
    if (!state.welcomed) {
      state.welcomed = true;
      await ctx.reply(welcomeMessage);
    }

    const lessons = await listLessons();
    if (lessons.length === 0) {
      await ctx.reply("No lessons are available yet.");
      return;
    }

    await ctx.reply(
      "📚 Choose a lesson:",
      Markup.inlineKeyboard(
        lessons.map(({ filename, title }, index) => [
          Markup.button.callback(`${index + 1}. ${title}`, `lesson:${filename}`),
        ]),
      ),
    );
  });

  // Handle lesson-selection callbacks generated by the /lesson menu.
  bot.action(/^lesson:(.+)$/, async (ctx) => {
    const state = getUserState(ctx.from.id);
    await ctx.answerCbQuery();
    if (state.processing) {
      await ctx.reply(busyMessage);
      return;
    }
    const filename = ctx.match[1];
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const lesson = (await listLessons()).find((item) => item.filename === filename);
    if (!lesson) {
      await ctx.reply("That lesson is no longer available.");
      return;
    }

    if (!acquirePiRequest(state)) {
      await ctx.reply(serviceBusyMessage);
      return;
    }
    const requestId = randomUUID();
    const lessonPrompt = `/skill:lesson Start the lesson from lessons/${filename}.`;
    logRequest(ctx.from.id, requestId, "started", { prompt: lessonPrompt });
    let placeholder;
    try {
      placeholder = await ctx.reply(`📖 Starting lesson: ${lesson.title}...`);
    } catch (error) {
      logRequest(ctx.from.id, requestId, "failed");
      releasePiRequest(ctx.from.id, state);
      throw error;
    }

    const prompt = ctx.persistentChatAction("typing", async () => {
      const response = await promptPi(await getSession(state), lessonPrompt);
      const reply = response || "Pi returned no text response.";
      await ctx.telegram.editMessageText(
        chatId,
        placeholder.message_id,
        undefined,
        `📖 Lesson started: ${lesson.title}\n\n${reply}`,
      );
      logRequest(ctx.from.id, requestId, "succeeded", { response });
    });

    state.pendingPrompt = prompt.catch(async () => {
      logRequest(ctx.from.id, requestId, "failed");
      console.error("Lesson prompt failed.");
      await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined,
        "Sorry, something went wrong while starting the lesson.\nPlease try again.").catch(() =>
        console.error("Lesson error message edit failed."));
    }).finally(() => {
      releasePiRequest(ctx.from.id, state);
    });
  });

  bot.on(message("text"), async (ctx) => {
    const state = getUserState(ctx.from.id);
    if (state.processing) {
      await ctx.reply(busyMessage);
      return;
    }
    if (!state.welcomed) {
      state.welcomed = true;
      await ctx.reply(welcomeMessage);
    }

    if (state.processing) {
      await ctx.reply(busyMessage);
      return;
    }

    if (!acquirePiRequest(state)) {
      await ctx.reply(serviceBusyMessage);
      return;
    }
    const requestId = randomUUID();
    logRequest(ctx.from.id, requestId, "started", { prompt: ctx.message.text });
    let placeholder;
    try {
      placeholder = await ctx.reply("🤔 Thinking...");
    } catch (error) {
      logRequest(ctx.from.id, requestId, "failed");
      releasePiRequest(ctx.from.id, state);
      throw error;
    }

    const prompt = ctx.persistentChatAction("typing", async () => {
      const response = await promptPi(await getSession(state), ctx.message.text);
      const reply = response || "Pi returned no text response.";
      await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, reply);
      logRequest(ctx.from.id, requestId, "succeeded", { response });
    });

    state.pendingPrompt = prompt.catch(() => {
      logRequest(ctx.from.id, requestId, "failed");
      console.error("Pi prompt failed.");
      return ctx.telegram
        .editMessageText(
          ctx.chat.id,
          placeholder.message_id,
          undefined,
          "Sorry, something went wrong while generating a response.\nPlease try again.",
        )
        .catch(() => {
          console.error("Pi error message edit failed.");
        })
        .then(() => undefined);
    }).finally(() => {
      releasePiRequest(ctx.from.id, state);
    });

  });

  return {
    bot,
    userStates,
    cleanupIdleUsers,
    getActivePiRequests: () => activePiRequests,
  };
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  const { bot } = createBridgeBot({ token });
  await bot.launch();
}
