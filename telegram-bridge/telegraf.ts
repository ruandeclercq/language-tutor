import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
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

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

if (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) {
  throw new Error("TELEGRAM_ALLOWED_USER_ID must be a positive integer");
}

const bot = new Telegraf(token);

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

I'm here to help you practice your target language.

You can:
- Work through structured lessons
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

// bot.use() is middleware - it runs before your handlers and can inspect, modify, or reject an incoming update.
bot.use((ctx, next) => {
  if (ctx.from?.id !== allowedUserId) {
    return;
  }

  return next();
});

await bot.telegram.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show help" },
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
    await ctx.telegram.editMessageText(
      chatId,
      placeholder.message_id,
      undefined,
      response || "Pi returned no text response.",
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
