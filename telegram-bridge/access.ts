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
  | { kind: "promo-code-prompt" }
  | { kind: "registration-name-prompt" }
  | { kind: "registration-recorded" }
  | { kind: "invalid-registration" }
  | { kind: "invalid-promo-code" }
  | { kind: "promo-locked" }
  | { kind: "promo-approved" };

type RegistrationStep = "choice" | "promo-code" | "name";

type PendingRegistration = {
  step: RegistrationStep;
  expiresAt: number;
};

const promoAttemptWindowMs = 15 * 60 * 1000;
const maxPromoAttempts = 5;

function normalizePromoCode(code: string): string {
  return code.trim().toLowerCase();
}

function registrationChoice(text: string): "promo-code" | "name" | undefined {
  const choice = text.trim().toLowerCase();
  if (["si", "sí", "yes", "y"].includes(choice)) return "promo-code";
  if (["no", "n"].includes(choice)) return "name";
  return undefined;
}

export function createAccessGate(options: {
  loadAllowedUsers: () => Promise<Map<number, AllowedUser>>;
  recordRegistration: (request: { telegramUserId: number; username: string | null; name: string; requestedAt: string }) => Promise<void>;
  approveUser?: (user: AllowedUser) => Promise<void>;
  promoCode?: string;
  now?: () => number;
  registrationExpiryMs?: number;
}) {
  const now = options.now ?? Date.now;
  const expiry = options.registrationExpiryMs ?? 10 * 60 * 1000;
  const pending = new Map<number, PendingRegistration>();
  const promoAttempts = new Map<number, { failedAt: number[]; lockedUntil?: number }>();
  return {
    async decide(input: { userId: number; username?: string; name?: string; text?: string; registerCommand: boolean }): Promise<AccessDecision> {
      const approved = (await options.loadAllowedUsers()).has(input.userId);
      if (input.registerCommand) {
        if (approved) return { kind: "already-approved" };
        pending.set(input.userId, { step: "choice", expiresAt: now() + expiry });
        return { kind: "registration-prompt" };
      }
      if (approved) {
        pending.delete(input.userId);
        return { kind: "approved" };
      }
      const registration = pending.get(input.userId);
      if (registration !== undefined) {
        if (registration.expiresAt <= now()) pending.delete(input.userId);
        else if (typeof input.text === "string" && !input.text.trim().startsWith("/")) {
          if (registration.step === "choice") {
            const choice = registrationChoice(input.text);
            if (choice === "promo-code") {
              registration.step = "promo-code";
              return { kind: "promo-code-prompt" };
            }
            if (choice === "name") {
              registration.step = "name";
              return { kind: "registration-name-prompt" };
            }
            return { kind: "registration-prompt" };
          }
          if (registration.step === "promo-code") {
            const attempts = promoAttempts.get(input.userId);
            if (attempts?.lockedUntil !== undefined && attempts.lockedUntil > now()) {
              return { kind: "promo-locked" };
            }
            if (attempts?.lockedUntil !== undefined) promoAttempts.delete(input.userId);
            if (options.promoCode && options.approveUser && normalizePromoCode(input.text) === normalizePromoCode(options.promoCode)) {
              const name = sanitizeName(input.name ?? "") ?? `Usuario ${input.userId}`;
              await options.approveUser({ telegramUserId: input.userId, name, approvedAt: new Date(now()).toISOString() });
              pending.delete(input.userId);
              promoAttempts.delete(input.userId);
              return { kind: "promo-approved" };
            }
            const failedAt = (attempts?.failedAt ?? []).filter((time) => time > now() - promoAttemptWindowMs);
            failedAt.push(now());
            if (failedAt.length >= maxPromoAttempts) {
              const lockedUntil = now() + promoAttemptWindowMs;
              promoAttempts.set(input.userId, { failedAt, lockedUntil });
              return { kind: "promo-locked" };
            }
            promoAttempts.set(input.userId, { failedAt });
            return { kind: "invalid-promo-code" };
          }
          const name = sanitizeName(input.text);
          if (!name) return { kind: "invalid-registration" };
          await options.recordRegistration({ telegramUserId: input.userId, username: input.username ?? null, name, requestedAt: new Date(now()).toISOString() });
          pending.delete(input.userId);
          return { kind: "registration-recorded" };
        }
      }
      pending.set(input.userId, { step: "choice", expiresAt: now() + expiry });
      return { kind: "registration-prompt" };
    },
    cleanupExpired() {
      const time = now();
      for (const [id, registration] of pending) if (registration.expiresAt <= time) pending.delete(id);
      for (const [id, attempts] of promoAttempts) if (attempts.lockedUntil !== undefined && attempts.lockedUntil <= time) promoAttempts.delete(id);
    },
  };
}
