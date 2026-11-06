import "dotenv/config";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = "../agent/";

export async function createLessonSession() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    authStorage,
    modelRegistry,
    tools: ["read", "grep", "find", "ls"],
  });

  async function promptTutor(prompt: string) {
    let responseText = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "agent_end") return;
      const response = event.messages.at(-1);
      if (response?.role !== "assistant") return;
      for (const part of response.content) {
        if (part.type === "text") responseText += part.text;
      }
    });

    try {
      await session.prompt(prompt);
      return responseText.trim();
    } finally {
      unsubscribe();
    }
  }

  return { promptTutor, dispose: () => session.dispose() };
}
