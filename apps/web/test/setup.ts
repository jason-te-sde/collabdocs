import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, beforeEach, vi } from "vitest";
import { getRedis } from "@/lib/redis";
import { getDb } from "@/lib/db";
import { signInAs } from "./helpers";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

process.env.COLLAB_TOKEN_SECRET = "test-collab-secret-0123456789-abcdefghij";
process.env.REDIS_MESSAGE_SECRET = "test-redis-message-secret-0123456789-abcd";
process.env.AUTH_SECRET = "test-auth-secret-that-differs-0123456789";
delete process.env.COLLAB_TOKEN_TTL_SECONDS;

// Mail goes to files that the tests read. The rate limits are far above what any test
// does, except in the tests that set their own; their counters live under a prefix of
// their own, which is emptied before each test.
const MAIL_DIR = path.join(os.tmpdir(), `collabdocs-mail-${process.pid}`);
process.env.MAIL_TRANSPORT = "file";
process.env.MAIL_OUTBOX_DIR = MAIL_DIR;
process.env.RATE_LIMIT_PREFIX = `collabdocs:rl-test-${process.pid}:`;
for (const name of [
  "AUTH_LIMIT_SIGNIN_PER_IP",
  "AUTH_LIMIT_SIGNIN_PER_ACCOUNT",
  "AUTH_LIMIT_REGISTER_PER_IP",
  "AUTH_LIMIT_REGISTER_PER_ACCOUNT",
  "AUTH_LIMIT_VERIFY_RESEND_PER_ACCOUNT",
]) {
  process.env[name] = "1000";
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set; the tests need a PostgreSQL database");
const database = new URL(url).pathname.slice(1);
// The tests delete every row. Refuse to run against anything that is not a test database.
if (!database.includes("test")) {
  throw new Error(`refusing to run against database "${database}": its name must contain "test"`);
}

async function clearRateLimits(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const keys = await redis.keys(`${process.env.RATE_LIMIT_PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await rm(MAIL_DIR, { recursive: true, force: true });
  await clearRateLimits();
  await getDb().$executeRawUnsafe(
    'TRUNCATE "DocumentUpdate", "DocumentSnapshot", "Membership", "Document", "Account", "Session", "VerificationToken", "PendingInvite", "User" CASCADE',
  );
  signInAs(null);
});

afterAll(async () => {
  await clearRateLimits();
  await getDb().$disconnect();
  getRedis()?.disconnect();
});
