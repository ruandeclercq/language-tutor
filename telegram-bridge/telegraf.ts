import "dotenv/config";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { Markup } from "telegraf";
import { PostHog } from "posthog-node";
import { createAccessGate, createAllowedUsersLoader, type AllowedUser } from "./access.js";
import { createPiRequestCoordinator, type PiRequestState } from "./pi-request.js";
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
const maxVoiceDurationSeconds = 5 * 60;
const maxVoiceFileSizeBytes = 20 * 1024 * 1024;
const posthogShutdownTimeoutMs = 1_000;
const posthogEuHost = "https://eu.i.posthog.com";

type PiSession = Pick<Awaited<ReturnType<typeof createAgentSession>>["session"],
  "isStreaming" | "abort" | "dispose" | "prompt" | "subscribe">;
type PiTool = typeof readOnlyPiTools[number];
type AnalyticsEvent =
  | "bot_started"
  | "registration_started"
  | "registration_submitted"
  | "lesson_picker_shown"
  | "lesson_selected"
  | "lesson_action_selected"
  | "lesson_started"
  | "lesson_completed"
  | "learner_message_submitted";
type AnalyticsProperties = Record<string, string>;

export type ProductAnalytics = {
  capture(userId: number, event: AnalyticsEvent, properties?: AnalyticsProperties): void;
  shutdown(): Promise<void>;
};

export function createPostHogAnalytics(
  apiKey = process.env.POSTHOG_API_KEY,
  host = process.env.POSTHOG_HOST,
): ProductAnalytics | undefined {
  if (!apiKey) return undefined;

  try {
    const client = new PostHog(apiKey, { host: host?.trim() || posthogEuHost });
    return {
      capture: (userId, event, properties) => {
        client.capture({ distinctId: String(userId), event, properties });
      },
      shutdown: () => client._shutdown(posthogShutdownTimeoutMs),
    };
  } catch {
    return undefined;
  }
}

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

export type BridgeOptions = {
  token: string;
  loadAllowedUsers?: () => Promise<Map<number, AllowedUser>>;
  getLessons?: () => Promise<Array<{ filename: string; title: string }>>;
  createPiSession?: (tools: readonly PiTool[]) => Promise<PiSession>;
  recordRegistration?: (request: RegistrationRequest) => Promise<void>;
  now?: () => number;
  debugLogContent?: boolean;
  downloadVoice?: (fileId: string) => Promise<Blob>;
  transcribeVoice?: (audio: Blob) => Promise<string>;
  // Pass null to disable analytics explicitly, including in tests.
  analytics?: ProductAnalytics | null;
};

export function createBridgeBot(options: BridgeOptions) {
  const bot = new Telegraf(options.token);
  const now = options.now ?? Date.now;
  const debugLogContent = options.debugLogContent ?? process.env.TELEGRAM_DEBUG_LOG_CONTENT === "1";
  const analytics = options.analytics === undefined ? createPostHogAnalytics() : options.analytics ?? undefined;

  function capture(userId: number, event: AnalyticsEvent, properties?: AnalyticsProperties) {
    try {
      analytics?.capture(userId, event, properties);
    } catch {
      console.error("Analytics capture failed.");
    }
  }

  async function shutdown() {
    try {
      await analytics?.shutdown();
    } catch {
      console.error("Analytics shutdown failed.");
    }
  }

  const privateAccessMessage =
    "👋 Este bot es privado.\n\n" +
    "Usa /register para pedir acceso.";
  const busyMessage = "⏳ Todavía estoy trabajando.\nEspera un momento.";
  const serviceBusyMessage = "El servicio está ocupado.\nInténtalo más tarde.";
  const findAllowedUsers = options.loadAllowedUsers ?? createAllowedUsersLoader(allowedUsersPath);
  const accessGate = createAccessGate({
    loadAllowedUsers: findAllowedUsers,
    now,
    recordRegistration: options.recordRegistration ?? ((entry) => appendRegistrationRequest(accessRequestsPath, entry)),
  });

  async function downloadVoice(fileId: string): Promise<Blob> {
    const url = await bot.telegram.getFileLink(fileId);
    const response = await fetch(url.href);
    if (!response.ok) {
      throw new Error(`Telegram voice download failed: ${response.status}`);
    }
    return new Blob([await response.arrayBuffer()]);
  }

  async function transcribeVoice(audio: Blob): Promise<string> {
    const apiKey = process.env.HAIMAKER_API_KEY;
    if (!apiKey) {
      throw new Error("HAIMAKER_API_KEY is not set");
    }
    const form = new FormData();
    form.set("model", "openai/gpt-4o-transcribe");
    form.set("file", audio, "voice.ogg");
    const response = await fetch("https://api.haimaker.ai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Voice transcription failed: ${response.status}`);
    }
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null ||
      typeof (result as { text?: unknown }).text !== "string") {
      throw new Error("Voice transcription returned an invalid response");
    }
    return (result as { text: string }).text.trim();
  }

  const fetchVoice = options.downloadVoice ?? downloadVoice;
  const createTranscript = options.transcribeVoice ?? transcribeVoice;

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
  type UserState = PiRequestState & {
    pendingLesson?: string;
    activeLesson?: string;
    reviewedPhrases?: string[];
    lessonComplete?: boolean;
    transcribing?: boolean;
    welcomed: boolean;
    lastActivityAt: number;
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

  function disposeUserState(userId: number, state: PiRequestState) {
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
    accessGate.cleanupExpired();
    for (const [userId, state] of userStates) {
      if (!state.processing && !state.transcribing && state.lastActivityAt <= cutoff) {
        disposeUserState(userId, state);
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
      if (state.discardWhenIdle && !state.processing) {
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

  const piRequests = createPiRequestCoordinator({
    createSession: () => sessionFactory(readOnlyPiTools),
    promptSession: promptPi,
    log: logRequest,
    disposeState: disposeUserState,
  });

  const welcomeMessage = `👋 ¡Hola!

  Practica conversaciones de tus clases de español con texto o voz.`;

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

  function consumeLessonCompletion(response: string, state: UserState) {
    if (!response.includes("[[LESSON_COMPLETE]]")) return response;
    state.lessonComplete = true;
    state.activeLesson = undefined;
    return response.replace(/\s*\[\[LESSON_COMPLETE\]\]\s*/g, "\n").trim();
  }

  async function showLessonPicker(
    ctx: { from?: { id: number }; reply: (...args: any[]) => Promise<unknown> },
    reason?: "command" | "first_use" | "completion",
  ) {
    const lessons = await listLessons();
    if (lessons.length === 0) {
      await ctx.reply("No hay lecciones disponibles.");
      return false;
    }

    await ctx.reply(
      "📚 Elige una lección:",
      Markup.inlineKeyboard(
        lessons.map(({ filename, title }, index) => [
          Markup.button.callback(`${index + 1}. ${title}`, `lesson:${filename}`),
        ]),
      ),
    );
    if (reason && ctx.from) {
      capture(ctx.from.id, "lesson_picker_shown", { reason });
    }
    return true;
  }

  function lessonActions(filename: string) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("Empezar", `start:${filename}`)],
      [Markup.button.callback("Ver resumen de la lección", `summary:${filename}`)],
      [Markup.button.callback("Ver 5 frases útiles", `prepare:${filename}`)],
      [Markup.button.callback("Volver", `back:${filename}`)],
    ]);
  }

  async function findPendingLesson(state: UserState, filename: string) {
    if (state.pendingLesson !== filename) return undefined;
    return (await listLessons()).find((lesson) => lesson.filename === filename);
  }

  function isCommand(text: string | undefined, command: string) {
    return text !== undefined && text.trim().match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, "i")) !== null;
  }

  // Authorization is checked for every update so manual allowlist changes take effect immediately.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) {
      return;
    }

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
    const decision = await accessGate.decide({
      userId: ctx.from.id,
      username: ctx.from.username,
      text,
      registerCommand: isCommand(text, "register"),
    });
    const approved = decision.kind === "approved" || decision.kind === "already-approved";

    // Telegram command scopes are per chat, so tutoring commands are only shown
    // after an approved user sends an update. Authorization below remains the
    // authority for every update, including stale command-menu entries.
    await configureCommandMenu(ctx.from.id, approved).catch(() =>
      console.error("Command menu configuration failed."));

    if (!approved) {
      const state = userStates.get(ctx.from.id);
      if (state) {
        if (state.processing || state.transcribing) {
          state.discardWhenIdle = true;
        } else {
          disposeUserState(ctx.from.id, state);
        }
      }
    }

    if (decision.kind === "already-approved") {
        await ctx.reply("Ya tienes acceso.");
      return;
    }
    if (decision.kind === "registration-prompt") {
      capture(ctx.from.id, "registration_started");
      await ctx.reply("¿Cómo te llamas?");
      return;
    }
    if (decision.kind === "invalid-registration") {
      await ctx.reply("Escribe un nombre válido (máximo 100 caracteres).");
      return;
    }
    if (decision.kind === "registration-recorded") {
      capture(ctx.from.id, "registration_submitted");
      await ctx.reply("Solicitud registrada. Escribe por WhatsApp al +27 66 118 6289 para pedir acceso.");
      return;
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
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }

    try {
      state.pendingLesson = undefined;
      state.activeLesson = undefined;
      state.reviewedPhrases = undefined;
      state.lessonComplete = false;
      await resetSession(ctx.from.id, state);
      state.welcomed = true;
      capture(ctx.from.id, "bot_started");
      await ctx.reply(welcomeMessage);
      await showLessonPicker(ctx, "command");
    } catch {
      console.error("Session reset failed.");
      await ctx.reply("No pude iniciar una sesión nueva. Inténtalo otra vez.");
    }
  });
  bot.help((ctx) => {
    getUserState(ctx.from.id).welcomed = true;
    return ctx.reply(welcomeMessage);
  });

  bot.command("lesson", async (ctx) => {
    const state = getUserState(ctx.from.id);
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    if (!state.welcomed) {
      state.welcomed = true;
      await ctx.reply(welcomeMessage);
    }

    await showLessonPicker(ctx, "command");
  });

  // Selecting a lesson only prepares it; roleplay starts after confirmation.
  bot.action(/^lesson:(.+)$/, async (ctx) => {
    const state = getUserState(ctx.from.id);
    await ctx.answerCbQuery();
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    const filename = ctx.match[1];
    const lesson = (await listLessons()).find((item) => item.filename === filename);
    if (!lesson) {
      await ctx.reply("Esa lección ya no está disponible.");
      return;
    }
    state.pendingLesson = filename;
    state.reviewedPhrases = [];
    state.lessonComplete = false;
    await ctx.reply(`📖 ${lesson.title}\n\n¿Qué quieres hacer?`, lessonActions(filename));
    capture(ctx.from.id, "lesson_selected", { lesson_filename: filename });
  });

  bot.action(/^prepare:(.+)$/, async (ctx) => {
    const state = getUserState(ctx.from.id);
    await ctx.answerCbQuery();
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    const filename = ctx.match[1];
    const lesson = await findPendingLesson(state, filename);
    if (!lesson) {
      await ctx.reply("Esa lección ya no está disponible.");
      return;
    }
    capture(ctx.from.id, "lesson_action_selected", { action: "prepare" });
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const previousPhrases = state.reviewedPhrases?.join("\n") || "None.";
    const accepted = await piRequests.run({
      userId: ctx.from.id,
      state,
      requestId: randomUUID(),
      prompt: `Read lessons/${filename} and return exactly five short scenario-relevant phrases in this format: Spanish phrase — brief English meaning. Use only language explicitly taught in the lesson. Do not repeat any Spanish phrase already shown in earlier reviews:\n${previousPhrases}\nDo not quiz the student, initiate roleplay, or change lesson state.`,
      callbacks: {
        start: async () => await ctx.reply("📖 Preparando 5 frases útiles...") as any,
        withTyping: async (work) => { let result = ""; await ctx.persistentChatAction("typing", async () => { result = await work(); }); return result; },
        success: async (response, placeholder) => {
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined,
            response || "Pi no devolvió ninguna respuesta de texto.");
          if (response) state.reviewedPhrases = [...state.reviewedPhrases ?? [], response];
          await ctx.reply("¿Qué quieres hacer?", lessonActions(filename));
        },
        failure: async (placeholder) => {
          if (!placeholder) return;
          console.error("Lesson preparation prompt failed.");
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined,
            "No pude preparar las frases útiles.\nInténtalo otra vez.").catch(() =>
            console.error("Lesson preparation error message edit failed."));
        },
      },
    });
    if (!accepted) await ctx.reply(serviceBusyMessage);
  });

  // A review reads the selected lesson without changing the session into an active roleplay.
  bot.action(/^summary:(.+)$/, async (ctx) => {
    const state = getUserState(ctx.from.id);
    await ctx.answerCbQuery();
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    const filename = ctx.match[1];
    const lesson = await findPendingLesson(state, filename);
    if (!lesson) {
      await ctx.reply("Esa lección ya no está disponible.");
      return;
    }
    capture(ctx.from.id, "lesson_action_selected", { action: "summary" });
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const accepted = await piRequests.run({
      userId: ctx.from.id,
      state,
      requestId: randomUUID(),
      prompt: `Read lessons/${filename} and return a compact lesson review of 3500 characters or fewer. Use only material explicitly taught in the lesson. Include: the scenario and roles; key vocabulary; useful phrases; taught grammar or patterns; and all examples taught in the lesson. In the useful phrases section, every phrase must be on its own line in exactly this format: Spanish phrase — brief English meaning. Do not omit an English meaning for any useful phrase. Do not quiz the student, initiate roleplay, or change lesson state.`,
      callbacks: {
        start: async () => await ctx.reply("📖 Preparando el resumen de la lección...") as any,
        withTyping: async (work) => { let result = ""; await ctx.persistentChatAction("typing", async () => { result = await work(); }); return result; },
        success: async (response, placeholder) => {
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined,
            response || "Pi no devolvió ninguna respuesta de texto.");
          await ctx.reply("¿Qué quieres hacer?", lessonActions(filename));
        },
        failure: async (placeholder) => {
          if (!placeholder) return;
          console.error("Lesson summary prompt failed.");
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined,
            "No pude preparar el resumen de la lección.\nInténtalo otra vez.").catch(() =>
            console.error("Lesson summary error message edit failed."));
        },
      },
    });
    if (!accepted) await ctx.reply(serviceBusyMessage);
  });

  bot.action(/^start:(.+)$/, async (ctx) => {
    const state = getUserState(ctx.from.id);
    await ctx.answerCbQuery();
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    const filename = ctx.match[1];
    const lesson = await findPendingLesson(state, filename);
    if (!lesson) {
      await ctx.reply("Esa lección ya no está disponible.");
      return;
    }
    capture(ctx.from.id, "lesson_action_selected", { action: "start" });
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    try {
      await resetSession(ctx.from.id, state);
    } catch {
      console.error("Session reset failed.");
      await ctx.reply("No pude iniciar una sesión nueva. Inténtalo otra vez.");
      return;
    }
    state.activeLesson = filename;
    state.pendingLesson = undefined;
    state.reviewedPhrases = undefined;
    state.lessonComplete = false;
    const accepted = await piRequests.run({
      userId: ctx.from.id,
      state,
      requestId: randomUUID(),
      prompt: `/skill:lesson Start the lesson from lessons/${filename}.`,
      callbacks: {
        start: async () => await ctx.reply(`📖 Iniciando la lección: ${lesson.title}...`) as any,
        withTyping: async (work) => { let result = ""; await ctx.persistentChatAction("typing", async () => { result = await work(); }); return result; },
        success: async (response, placeholder) => {
          const reply = consumeLessonCompletion(response, state) || "Pi no devolvió ninguna respuesta de texto.";
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, `📖 Lección iniciada: ${lesson.title}\n\n${reply}`);
          capture(ctx.from.id, "lesson_started", { lesson_filename: filename });
          if (state.lessonComplete) {
            capture(ctx.from.id, "lesson_completed", { lesson_filename: filename });
            await showLessonPicker(ctx, "completion");
          }
        },
        failure: async (placeholder) => {
          if (!placeholder) return;
          console.error("Lesson prompt failed.");
          const errorMessage = "No pude iniciar la lección.\nInténtalo otra vez.";
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, errorMessage).catch(async () => {
            console.error("Lesson error message edit failed.");
            await ctx.reply(errorMessage).catch(() => console.error("Lesson error message reply failed."));
          });
        },
      },
    });
    if (!accepted) await ctx.reply(serviceBusyMessage);
  });

  bot.action(/^back:(.+)$/, async (ctx) => {
    const state = getUserState(ctx.from.id);
    await ctx.answerCbQuery();
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    if (state.pendingLesson !== ctx.match[1]) {
      await ctx.reply("Esa lección ya no está disponible.");
      return;
    }
    state.pendingLesson = undefined;
    state.reviewedPhrases = undefined;
    await showLessonPicker(ctx);
  });

  async function handleUserText(ctx: any, text: string, inputType: "text" | "voice" = "text") {
    const state = getUserState(ctx.from.id);
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    const firstUse = !state.welcomed;
    if (firstUse) {
      state.welcomed = true;
      await ctx.reply(welcomeMessage);
    }

    if (!state.activeLesson) {
      await showLessonPicker(ctx, firstUse ? "first_use" : undefined);
      return;
    }

    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }

    const requestId = randomUUID();
    const accepted = await piRequests.run({
      userId: ctx.from.id,
      state,
      requestId,
      prompt: text,
      callbacks: {
        start: async () => await ctx.reply("🤔 Pensando...") as any,
        withTyping: async (work) => { let result = ""; await ctx.persistentChatAction("typing", async () => { result = await work(); }); return result; },
        success: async (response, placeholder) => {
          const completedLesson = state.activeLesson;
          const reply = consumeLessonCompletion(response, state) || "Pi no devolvió ninguna respuesta de texto.";
          await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, reply);
          if (state.lessonComplete && completedLesson) {
            capture(ctx.from.id, "lesson_completed", { lesson_filename: completedLesson });
            await showLessonPicker(ctx, "completion");
          }
        },
        failure: async (placeholder) => {
          if (!placeholder) return;
          console.error("Pi prompt failed.");
          await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, "No pude generar una respuesta.\nInténtalo otra vez.").catch(() => {
            console.error("Pi error message edit failed.");
          });
        },
      },
    });
    if (!accepted) await ctx.reply(serviceBusyMessage);
    else capture(ctx.from.id, "learner_message_submitted", { input_type: inputType });
  }

  bot.on(message("text"), async (ctx) => {
    if (ctx.message.text.trim().startsWith("/")) {
      return;
    }
    await handleUserText(ctx, ctx.message.text);
  });

  bot.on(message("voice"), async (ctx) => {
    const voice = ctx.message.voice;
    const state = getUserState(ctx.from.id);
    if (state.processing || state.transcribing) {
      await ctx.reply(busyMessage);
      return;
    }
    if (voice.duration > maxVoiceDurationSeconds) {
      await ctx.reply("La nota no puede durar más de 5 minutos.");
      return;
    }
    if (voice.file_size !== undefined && voice.file_size > maxVoiceFileSizeBytes) {
      await ctx.reply("La nota no puede superar 20 MB.");
      return;
    }
    if (!state.activeLesson) {
      const firstUse = !state.welcomed;
      if (firstUse) {
        state.welcomed = true;
        await ctx.reply(welcomeMessage);
      }
      await showLessonPicker(ctx, firstUse ? "first_use" : undefined);
      return;
    }
    if (!process.env.HAIMAKER_API_KEY && !options.transcribeVoice) {
      await ctx.reply("La transcripción de voz no está disponible. Envía texto.");
      return;
    }

    state.transcribing = true;
    try {
      const transcribingMessage = await ctx.reply("🎙️ Transcribiendo...");
      let audio: Blob;
      try {
        audio = await fetchVoice(voice.file_id);
      } catch (error) {
        console.error("Voice download failed.", error);
        await ctx.reply("No pude descargar la nota. Inténtalo otra vez.");
        return;
      }
      if (audio.size > maxVoiceFileSizeBytes) {
        await ctx.reply("La nota no puede superar 20 MB.");
        return;
      }
      let transcript: string;
      try {
        transcript = await createTranscript(audio);
      } catch (error) {
        console.error("Voice transcription failed.", error);
        await ctx.reply("No pude transcribir la nota. Inténtalo otra vez.");
        return;
      }
      if (!transcript) {
        await ctx.reply("No pude oír la nota. Inténtalo otra vez.");
        return;
      }
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        transcribingMessage.message_id,
        undefined,
        `🎙️ He oído: ${transcript.slice(0, 3_500)}`,
      ).catch(() => console.error("Transcript message edit failed."));
      state.transcribing = false;
      await handleUserText(ctx, transcript, "voice");
    } finally {
      state.transcribing = false;
      if (state.discardWhenIdle && !state.processing) {
        disposeUserState(ctx.from.id, state);
      }
    }
  });

  return {
    bot,
    userStates,
    cleanupIdleUsers,
    getActivePiRequests: piRequests.getActive,
    shutdown,
  };
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  const bridge = createBridgeBot({ token });
  let shuttingDown = false;
  const stop = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      bridge.bot.stop(signal);
    } catch {
      console.error("Telegram shutdown failed.");
    }
    await bridge.shutdown();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  await bridge.bot.launch();
}
