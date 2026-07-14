import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = "../agent/";


async function main() {
  console.log("1. Creating AuthStorage");
  const authStorage = AuthStorage.create();

  console.log("2. Creating ModelRegistry");
  const modelRegistry = ModelRegistry.create(authStorage);

  console.log("3. Creating session");
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    authStorage,
    modelRegistry,
  });

  console.log("4. Session created");

  session.subscribe((event) => {
    console.dir(event, { depth: null });
  });

  console.log("5. Sending prompt");
  await session.prompt("Say hello");
  console.log("6. Prompt finished");
}

main().catch(console.error);
