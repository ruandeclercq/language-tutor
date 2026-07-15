import "dotenv/config";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
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

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type PiTool = typeof readOnlyPiTools[number];

type BridgeOptions = {
  token: string;
  loadAllowedUsers?: () => Promise<Map<number, AllowedUser>>;
  getLessons?: () => Promise<Array<{ filename: string; title: string }>>;
  createPiSession?: (tools: readonly PiTool[]) => Promise<PiSession>;
  now?: () => number;
};

export function createBridgeBot(options: BridgeOptions) {
  const bot = new Telegraf(options.token);
  const now = options.now ?? Date.now;

  type RegistrationRequest = {
    telegramUserId: number;
    username: string | null;
    name: string;
    requestedAt: string;
  };

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
    } catch (error) {
      console.error("Allowlist unavailable; denying access.", error);
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
    } catch (error) {
      console.error("Allowlist unavailable; denying access.", error);
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
    await mkdir(dataDirectory, { recursive: true });
    await appendFile(accessRequestsPath, `${JSON.stringify(request)}\n`, "utf8");
  }

  const log = (actor: string, message: string) => {
    console.log(`[${new Date().toISOString()}] [${actor}] ${message}`);
  };

  const userLabel = (ctx: { from?: { username?: string; id: number } }) =>
    `@${ctx.from?.username ?? "unknown"} (id:${ctx.from?.id ?? "unknown"})`;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const createPiSession = (tools: readonly PiTool[] = readOnlyPiTools) =>
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
    } catch (error) {
      console.error("Session disposal failed:", error);
    }
  }

  function cleanupIdleUsers() {
    const cutoff = now() - idleSessionMs;
    for (const [userId, state] of userStates) {
      if (!state.processing && state.lastActivityAt <= cutoff) {
        disposeUserState(userId, state);
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
  function releasePiRequest(userId: number, state: UserState, typingInterval?: ReturnType<typeof setInterval>) {
    if (typingInterval !== undefined) {
      clearInterval(typingInterval);
    }
    state.processing = false;
    state.pendingPrompt = Promise.resolve();
    activePiRequests -= 1;
    if (state.discardWhenIdle) {
      disposeUserState(userId, state);
    }
  }

  async function getSession(state: UserState): Promise<PiSession> {
    if (!state.session) {
      state.session = await sessionFactory(readOnlyPiTools);
    }
    return state.session!;
  }

  async function resetSession(userId: number, state: UserState) {
    await state.pendingPrompt;

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
  }

  const promptPi = (session: PiSession, prompt: string): Promise<string> => {
    return new Promise((resolve, reject) => {
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
          if (part.type === "thinking") {
            log("pi", `<thinking>${part.thinking}</thinking>`);
          } else if (part.type === "text") {
            responseText += part.text;
          }
        }

        responseText = responseText.trim();
        log("pi", responseText);
      });

      session.prompt(prompt)
        .then(() => resolve(responseText))
        .catch(reject)
        .finally(unsubscribe);
    });
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

  const sendTyping = (ctx: { chat?: { id: number }; telegram: { sendChatAction: (chatId: number, action: "typing") => Promise<unknown> } }) =>
    ctx.chat ? ctx.telegram.sendChatAction(ctx.chat.id, "typing") : Promise.resolve();

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
    await configureCommandMenu(ctx.from.id, approved).catch((error) =>
      console.error("Command menu configuration failed:", error));

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
        pendingRegistrations.set(ctx.from.id, Date.now() + registrationExpiryMs);
        await ctx.reply("What is your name?");
      }
      return;
    }

    const pendingUntil = pendingRegistrations.get(ctx.from.id);
    if (pendingUntil !== undefined) {
      if (pendingUntil <= Date.now()) {
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
  const configuredCommandMenus = new Map<number, boolean>();

  async function configureCommandMenu(userId: number, approved: boolean) {
    if (configuredCommandMenus.get(userId) === approved) {
      return;
    }
    await bot.telegram.setMyCommands(
      approved ? approvedCommands : publicCommands,
      { scope: { type: "chat", chat_id: userId } },
    );
    configuredCommandMenus.set(userId, approved);
  }

  bot.start(async (ctx) => {
    log(userLabel(ctx), "/start");
    const state = getUserState(ctx.from.id);
    if (state.processing) {
      await ctx.reply(busyMessage);
      return;
    }

    try {
      await resetSession(ctx.from.id, state);
      state.welcomed = true;
      await ctx.reply(welcomeMessage);
    } catch (error) {
      console.error("Session reset failed:", error);
      await ctx.reply("Sorry, I couldn't start a fresh session. Please try again.");
    }
  });
  bot.help((ctx) => {
    log(userLabel(ctx), "/help");
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
    let placeholder;
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      placeholder = await ctx.reply(`📖 Starting lesson: ${lesson.title}...`);
    } catch (error) {
      releasePiRequest(ctx.from.id, state);
      throw error;
    }
    typingInterval = setInterval(() => {
      void ctx.telegram.sendChatAction(chatId, "typing").catch((error) =>
        console.error("Typing indicator failed:", error),
      );
    }, 4_000);

    const prompt = (async () => {
      await ctx.telegram.sendChatAction(chatId, "typing");
      const response = await promptPi(await getSession(state), `Start the lesson from lessons/${filename}.`);
      const reply = response || "Pi returned no text response.";
      await ctx.telegram.editMessageText(
        chatId,
        placeholder.message_id,
        undefined,
        `📖 Lesson started: ${lesson.title}\n\n${reply}`,
      );
    })();

    state.pendingPrompt = prompt.catch(async (error) => {
      console.error("Lesson prompt failed:", error);
      await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined,
        "Sorry, something went wrong while starting the lesson.\nPlease try again.").catch((editError) =>
        console.error("Lesson error message edit failed:", editError));
    }).finally(() => {
      releasePiRequest(ctx.from.id, state, typingInterval);
    });
  });

  bot.on(message("text"), async (ctx) => {
    log(userLabel(ctx), ctx.message.text);

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
    let placeholder;
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      placeholder = await ctx.reply("🤔 Thinking...");
    } catch (error) {
      releasePiRequest(ctx.from.id, state);
      throw error;
    }
    typingInterval = setInterval(() => {
      void sendTyping(ctx).catch((error) => console.error("Typing indicator failed:", error));
    }, 4_000);

    const prompt = (async () => {
      await sendTyping(ctx);
      const response = await promptPi(await getSession(state), ctx.message.text);
      const reply = response || "Pi returned no text response.";
      await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, reply);
    })();

    state.pendingPrompt = prompt.catch((error) => {
      console.error("Pi prompt failed:", error);
      return ctx.telegram
        .editMessageText(
          ctx.chat.id,
          placeholder.message_id,
          undefined,
          "Sorry, something went wrong while generating a response.\nPlease try again.",
        )
        .catch((editError) => {
          console.error("Pi error message edit failed:", editError);
        })
        .then(() => undefined);
    }).finally(() => {
      releasePiRequest(ctx.from.id, state, typingInterval);
    });

  });

  return { bot, userStates, cleanupIdleUsers };
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  const { bot } = createBridgeBot({ token });
  await bot.launch();
}
