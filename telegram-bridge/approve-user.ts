import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Telegraf } from "telegraf";
import { parseAllowedUsers, sanitizeName, type AllowedUser } from "./access.js";
import { createPostHogAnalytics } from "./telegraf.js";

const allowedUsersPath = path.resolve("data", "allowed-users.json");
const accessRequestsPath = path.resolve("data", "access-requests.jsonl");
const approvalGreeting = "Hola! You now have access to LanguageTutor. Send /start to begin.";

export type RegistrationRequest = {
  telegramUserId: number;
  username: string | null;
  name: string;
  requestedAt: string;
};

function isRegistrationRequest(request: unknown): request is RegistrationRequest {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const { telegramUserId, username, name, requestedAt } = request as Partial<RegistrationRequest>;
  return Number.isSafeInteger(telegramUserId) &&
    (username === null || typeof username === "string") &&
    typeof name === "string" && sanitizeName(name) !== null &&
    typeof requestedAt === "string" && !Number.isNaN(Date.parse(requestedAt));
}

function parseRegistrationRequests(contents: string): RegistrationRequest[] {
  return contents.split("\n").filter(Boolean).map((line, index) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error(`Invalid access request on line ${index + 1}`);
    }
    if (!isRegistrationRequest(request)) {
      throw new Error(`Invalid access request on line ${index + 1}`);
    }
    return request;
  });
}

async function loadAllowedUsers(filePath: string): Promise<Map<number, AllowedUser>> {
  try {
    return parseAllowedUsers(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function listPendingRegistrations(
  requestsFilePath: string,
  allowedUsersFilePath: string,
): Promise<RegistrationRequest[]> {
  let requests: RegistrationRequest[];
  try {
    requests = parseRegistrationRequests(await readFile(requestsFilePath, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const allowedUsers = await loadAllowedUsers(allowedUsersFilePath);
  const latestRequests = new Map(requests.map((request) => [request.telegramUserId, request]));
  return Array.from(latestRequests.values()).filter(({ telegramUserId }) => !allowedUsers.has(telegramUserId));
}

export async function approveUser(
  filePath: string,
  user: AllowedUser,
  sendGreeting: (telegramUserId: number, greeting: string) => Promise<unknown>,
  onApproved?: (user: AllowedUser) => Promise<void>,
): Promise<boolean> {
  const users = await loadAllowedUsers(filePath);
  const added = !users.has(user.telegramUserId);
  if (added) {
    users.set(user.telegramUserId, user);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(Array.from(users.values()), null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
    await onApproved?.(user);
  }
  await sendGreeting(user.telegramUserId, approvalGreeting);
  return added;
}

function userFromArguments(args: string[]): Pick<AllowedUser, "telegramUserId" | "name"> {
  const [idArgument, ...nameParts] = args;
  const telegramUserId = Number(idArgument);
  const name = sanitizeName(nameParts.join(" "));
  if (!Number.isSafeInteger(telegramUserId) || !name) {
    throw new Error("Usage: npx tsx approve-user.ts [<telegram-user-id> <name>]");
  }
  return { telegramUserId, name };
}

async function selectPendingRegistration(): Promise<RegistrationRequest | undefined> {
  const requests = await listPendingRegistrations(accessRequestsPath, allowedUsersPath);
  if (requests.length === 0) {
    console.info("There are no pending access requests.");
    return undefined;
  }
  console.info("Pending access requests:");
  requests.forEach(({ name, username, telegramUserId }, index) =>
    console.info(`${index + 1}. ${name}${username ? ` (@${username})` : ""} - ${telegramUserId}`));
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const selected = Number(await prompt.question("Select a user to approve: ")) - 1;
    if (!Number.isInteger(selected) || !requests[selected]) {
      throw new Error("Select one of the listed numbers.");
    }
    return requests[selected];
  } finally {
    prompt.close();
  }
}

async function main(args: string[]) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  const user = args.length > 0 ? userFromArguments(args) : await selectPendingRegistration();
  if (!user) {
    return;
  }

  const telegram = new Telegraf(token).telegram;
  const analytics = createPostHogAnalytics();
  let added: boolean;
  try {
    added = await approveUser(
      allowedUsersPath,
      { ...user, approvedAt: new Date().toISOString() },
      (userId, greeting) => telegram.sendMessage(userId, greeting),
      async (approvedUser) => {
        try {
          analytics?.capture(approvedUser.telegramUserId, "user_signed_up", { signup_method: "manual_approval" });
        } catch {
          console.error("Analytics capture failed.");
        }
      },
    );
  } finally {
    try {
      await analytics?.shutdown();
    } catch {
      console.error("Analytics shutdown failed.");
    }
  }
  console.info(added ? `Approved ${user.telegramUserId} and sent greeting.` : `User ${user.telegramUserId} was already approved; sent greeting.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
