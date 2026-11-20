import { afterAll, beforeEach, vi } from "vitest";
import { getDb } from "@/lib/db";
import { signInAs } from "./helpers";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

process.env.COLLAB_TOKEN_SECRET = "test-collab-secret-0123456789-abcdefghij";
process.env.REDIS_MESSAGE_SECRET = "test-redis-message-secret-0123456789-abcd";
process.env.AUTH_SECRET = "test-auth-secret-that-differs-0123456789";
delete process.env.COLLAB_TOKEN_TTL_SECONDS;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set; the tests need a PostgreSQL database");
const database = new URL(url).pathname.slice(1);
// The tests delete every row. Refuse to run against anything that is not a test database.
if (!database.includes("test")) {
  throw new Error(`refusing to run against database "${database}": its name must contain "test"`);
}

beforeEach(async () => {
  await getDb().$executeRawUnsafe(
    'TRUNCATE "DocumentUpdate", "DocumentSnapshot", "Membership", "Document", "Account", "Session", "VerificationToken", "User" CASCADE',
  );
  signInAs(null);
});

afterAll(async () => {
  await getDb().$disconnect();
});
