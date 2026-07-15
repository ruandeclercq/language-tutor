import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = "../agent/";

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
  return ctx.reply("How can I help?");
});

bot.on(message("text"), async (ctx) => {
  log(userLabel(ctx), ctx.message.text);

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
