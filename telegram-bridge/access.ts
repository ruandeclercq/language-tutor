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
