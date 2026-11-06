export type PiRequestSession = {
  isStreaming: boolean;
  abort(): Promise<void>;
  dispose(): void;
  prompt(prompt: string): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
};

export type PiRequestState = {
  session?: PiRequestSession;
  pendingPrompt: Promise<void>;
  processing: boolean;
  discardWhenIdle?: boolean;
};

export type PiRequestCoordinatorOptions = {
  maxActive?: number;
  createSession: () => Promise<PiRequestSession>;
  promptSession: (session: PiRequestSession, prompt: string) => Promise<string>;
  log: (userId: number, requestId: string, outcome: "started" | "succeeded" | "failed", content?: { prompt?: string; response?: string }) => void;
  disposeState?: (userId: number, state: PiRequestState) => void;
};

export type PiRequestCallbacks<T> = {
  start: () => Promise<T>;
  success: (response: string, presentation: T) => Promise<void>;
  failure: (presentation: T | undefined) => Promise<void>;
  withTyping?: (work: () => Promise<string>) => Promise<string>;
};

export function createPiRequestCoordinator(options: PiRequestCoordinatorOptions) {
  const maxActive = options.maxActive ?? 10;
  let active = 0;

  const acquire = (state: PiRequestState) => {
    if (state.processing || active >= maxActive) return false;
    state.processing = true;
    active += 1;
    return true;
  };

  const release = (userId: number, state: PiRequestState) => {
    state.processing = false;
    state.pendingPrompt = Promise.resolve();
    active -= 1;
    if (state.discardWhenIdle) options.disposeState?.(userId, state);
  };

  const getSession = async (state: PiRequestState) => state.session ??= await options.createSession();

  async function run<T>(args: {
    userId: number;
    state: PiRequestState;
    requestId: string;
    prompt: string;
    callbacks: PiRequestCallbacks<T>;
  }): Promise<boolean> {
    if (!acquire(args.state)) return false;
    options.log(args.userId, args.requestId, "started", { prompt: args.prompt });
    let presentation: T | undefined;
    try {
      presentation = await args.callbacks.start();
    } catch (error) {
      options.log(args.userId, args.requestId, "failed");
      await args.callbacks.failure(presentation);
      release(args.userId, args.state);
      throw error;
    }

    const work = async (): Promise<void> => {
      const prompt = async (): Promise<string> => options.promptSession(await getSession(args.state), args.prompt);
      const response = args.callbacks.withTyping ? await args.callbacks.withTyping(prompt) : await prompt();
      await args.callbacks.success(response, presentation as T);
      options.log(args.userId, args.requestId, "succeeded", { response });
    };
    args.state.pendingPrompt = work().catch(async () => {
      options.log(args.userId, args.requestId, "failed");
      await args.callbacks.failure(presentation);
    }).finally(() => release(args.userId, args.state));
    return true;
  }

  return { run, getActive: () => active };
}
