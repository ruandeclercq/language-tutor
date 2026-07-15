import "dotenv/config";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { Markup } from "telegraf";
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

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

const bot = new Telegraf(token);

type AllowedUser = {
  telegramUserId: number;
  name: string;
  approvedAt: string;
};

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

async function seedAllowlistFromEnvironment() {
  const configuredId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
  if (!Number.isSafeInteger(configuredId) || configuredId <= 0) {
    console.warn("No valid TELEGRAM_ALLOWED_USER_ID found; allowlist will fail closed until populated.");
    return;
  }

  await mkdir(dataDirectory, { recursive: true });
  let users: AllowedUser[] = [];
  try {
    users = JSON.parse(await readFile(allowedUsersPath, "utf8"));
    if (!Array.isArray(users) || users.some((user) =>
      typeof user !== "object" || user === null ||
      !Number.isSafeInteger((user as AllowedUser).telegramUserId) ||
      typeof (user as AllowedUser).name !== "string" ||
      typeof (user as AllowedUser).approvedAt !== "string" ||
      Number.isNaN(Date.parse((user as AllowedUser).approvedAt)),
    )) {
      console.warn("Refusing to seed malformed allowlist.");
      return;
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Refusing to seed unreadable allowlist.", error);
      return;
    }
  }

  if (users.some((user) => user?.telegramUserId === configuredId)) {
    return;
  }

  users.push({
    telegramUserId: configuredId,
    name: "Seeded user",
    approvedAt: new Date().toISOString(),
  });
  await writeFile(allowedUsersPath, `${JSON.stringify(users, null, 2)}\n`, "utf8");
}

async function loadAllowedUsers(): Promise<Map<number, AllowedUser>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(allowedUsersPath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("allowlist must be an array");
    }

    const users = parsed.filter((user): user is AllowedUser =>
      typeof user === "object" && user !== null &&
      Number.isSafeInteger((user as AllowedUser).telegramUserId) &&
      typeof (user as AllowedUser).name === "string" &&
      typeof (user as AllowedUser).approvedAt === "string" &&
      !Number.isNaN(Date.parse((user as AllowedUser).approvedAt)),
    );
    if (users.length !== parsed.length) {
      throw new Error("allowlist contains malformed records");
    }
    return new Map(users.map((user) => [user.telegramUserId, user]));
  } catch (error) {
    console.error("Allowlist unavailable; denying access.", error);
    return new Map();
  }
}

function sanitizeName(input: string): string | null {
  const sanitized = input
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length > 0 && sanitized.length <= 100 ? sanitized : null;
}

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
const createSession = () =>
  createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    authStorage,
    modelRegistry,
  }).then(({ session }) => session);

let session = await createSession();

async function resetSession() {
  await pendingPrompt;

  if (session.isStreaming) {
    await session.abort();
  }

  session.dispose();
  session = await createSession();
}

const promptPi = (prompt: string): Promise<string> => {
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

let pendingPrompt = Promise.resolve();
let processing = false;
const welcomedUserIds = new Set<number>();

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

  const allowedUsers = await loadAllowedUsers();
  const approved = allowedUsers.has(ctx.from.id);
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;

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

  return next();
});

await seedAllowlistFromEnvironment();

await bot.telegram.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show help" },
  { command: "register", description: "Request private access" },
]);

bot.start(async (ctx) => {
  log(userLabel(ctx), "/start");
  await resetSession();
  await ctx.reply("Started a fresh Pi session.");
});
bot.help((ctx) => {
  log(userLabel(ctx), "/help");
  return ctx.reply(welcomeMessage);
});

bot.command("lesson", async (ctx) => {
  if (ctx.from && !welcomedUserIds.has(ctx.from.id)) {
    welcomedUserIds.add(ctx.from.id);
    await ctx.reply(welcomeMessage);
  }

  const lessons = await getLessons();
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

bot.action(/^lesson:(.+)$/, async (ctx) => {
  const filename = ctx.match[1];
  await ctx.answerCbQuery();
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const lesson = (await getLessons()).find((item) => item.filename === filename);
  if (!lesson) {
    await ctx.reply("That lesson is no longer available.");
    return;
  }

  if (processing) {
    await ctx.reply("⏳ I'm still working on your previous request.\nPlease wait for it to finish.");
    return;
  }

  processing = true;
  const placeholder = await ctx.reply(`📖 Starting lesson: ${lesson.title}...`);
  const typingInterval = setInterval(() => {
    void ctx.telegram.sendChatAction(chatId, "typing").catch((error) =>
      console.error("Typing indicator failed:", error),
    );
  }, 4_000);

  void (async () => {
    await ctx.telegram.sendChatAction(chatId, "typing");
    const response = await promptPi(`Start the lesson from lessons/${filename}.`);
    const reply = response || "Pi returned no text response.";
    await ctx.telegram.editMessageText(
      chatId,
      placeholder.message_id,
      undefined,
      `📖 Lesson started: ${lesson.title}\n\n${reply}`,
    );
  })().catch(async (error) => {
    console.error("Lesson prompt failed:", error);
    await ctx.telegram.editMessageText(
      chatId,
      placeholder.message_id,
      undefined,
      "Sorry, something went wrong while starting the lesson.\nPlease try again.",
    );
  }).finally(() => {
    clearInterval(typingInterval);
    processing = false;
  });
});

bot.on(message("text"), async (ctx) => {
  log(userLabel(ctx), ctx.message.text);

  if (ctx.from && !welcomedUserIds.has(ctx.from.id)) {
    welcomedUserIds.add(ctx.from.id);
    await ctx.reply(welcomeMessage);
  }

  if (processing) {
    await ctx.reply("⏳ I'm still working on your previous request.\nPlease wait for it to finish.");
    return;
  }

  processing = true;
  const placeholder = await ctx.reply("🤔 Thinking...");
  const typingInterval = setInterval(() => {
    void sendTyping(ctx).catch((error) => console.error("Typing indicator failed:", error));
  }, 4_000);

  const prompt = (async () => {
    await sendTyping(ctx);
    const response = await promptPi(ctx.message.text);
    const reply = response || "Pi returned no text response.";
    await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, reply);
  })();

  pendingPrompt = prompt.catch((error) => {
    console.error("Pi prompt failed:", error);
    return ctx.telegram
      .editMessageText(
        ctx.chat.id,
        placeholder.message_id,
        undefined,
        "Sorry, something went wrong while generating a response.\nPlease try again.",
      )
      .then(() => undefined);
  }).finally(() => {
    clearInterval(typingInterval);
    processing = false;
  });

});


await bot.launch();
