import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalForDb = globalThis as unknown as { collabdocsDb?: PrismaClient };

/** The shared Prisma client. Created on first use so that `next build` needs no database. */
export function getDb(): PrismaClient {
  if (!globalForDb.collabdocsDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForDb.collabdocsDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return globalForDb.collabdocsDb;
}

/** True for a unique-constraint violation, from Prisma or from the driver. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
