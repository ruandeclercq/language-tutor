import { readFile, stat } from "node:fs/promises";

export type AllowedUser = {
  telegramUserId: number;
  name: string;
  approvedAt: string;
};

export function parseAllowedUsers(parsed: unknown): Map<number, AllowedUser> {
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
}

export function sanitizeName(input: string): string | null {
  const sanitized = input
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length > 0 && sanitized.length <= 100 ? sanitized : null;
}

export function createAllowedUsersLoader(path: string, log: (message: string) => void = console.error) {
  let cached: Map<number, AllowedUser> | undefined;
  let cachedMtime: number | null | undefined;
  return async (): Promise<Map<number, AllowedUser>> => {
    let mtimeMs: number;
    try { ({ mtimeMs } = await stat(path)); }
    catch { log("Allowlist unavailable; denying access."); cached = new Map(); cachedMtime = null; return cached; }
    if (cached !== undefined && cachedMtime === mtimeMs) return cached;
    try {
      cached = parseAllowedUsers(JSON.parse(await readFile(path, "utf8")));
      cachedMtime = mtimeMs;
      return cached;
    } catch {
      log("Allowlist unavailable; denying access.");
      cached = new Map(); cachedMtime = mtimeMs;
      return cached;
    }
  };
}

export type AccessDecision =
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "already-approved" }
  | { kind: "registration-prompt" }
  | { kind: "registration-recorded" }
  | { kind: "invalid-registration" };

export function createAccessGate(options: {
  loadAllowedUsers: () => Promise<Map<number, AllowedUser>>;
  recordRegistration: (request: { telegramUserId: number; username: string | null; name: string; requestedAt: string }) => Promise<void>;
  now?: () => number;
  registrationExpiryMs?: number;
}) {
  const now = options.now ?? Date.now;
  const expiry = options.registrationExpiryMs ?? 10 * 60 * 1000;
  const pending = new Map<number, number>();
  return {
    async decide(input: { userId: number; username?: string; text?: string; registerCommand: boolean }): Promise<AccessDecision> {
      const approved = (await options.loadAllowedUsers()).has(input.userId);
      if (input.registerCommand) {
        if (approved) return { kind: "already-approved" };
        pending.set(input.userId, now() + expiry);
        return { kind: "registration-prompt" };
      }
      const pendingUntil = pending.get(input.userId);
      if (pendingUntil !== undefined) {
        if (pendingUntil <= now()) pending.delete(input.userId);
        else if (typeof input.text === "string" && !input.text.trim().startsWith("/")) {
          const name = sanitizeName(input.text);
          if (!name) return { kind: "invalid-registration" };
          await options.recordRegistration({ telegramUserId: input.userId, username: input.username ?? null, name, requestedAt: new Date(now()).toISOString() });
          pending.delete(input.userId);
          return { kind: "registration-recorded" };
        }
      }
      return approved ? { kind: "approved" } : { kind: "denied" };
    },
    cleanupExpired() { const time = now(); for (const [id, until] of pending) if (until <= time) pending.delete(id); },
  };
}
