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

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
  authStorage,
  modelRegistry,
});

const promptPi = (prompt: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    let responseText = "";

    session.subscribe((event) => {
      if (event.type !== "agent_end") {
        return;
      }

      const response = event.messages.at(-1);
      if (response?.role !== "assistant") {
        return;
      }

      responseText = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
    });

    session.prompt(prompt).then(() => resolve(responseText)).catch(reject);
  });
};

let pendingPrompt = Promise.resolve();

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

bot.start((ctx) => ctx.reply("Connected to your Pi instance."));
bot.help((ctx) => ctx.reply("How can I help?"));

bot.on(message("text"), async (ctx) => {
  const prompt = pendingPrompt.then(async () => {
    const response = await promptPi(ctx.message.text);
    await ctx.reply(response || "Pi returned no text response.");
  });

  pendingPrompt = prompt.catch((error) => {
    console.error("Pi prompt failed:", error);
  });

  await prompt;
});


await bot.launch();
