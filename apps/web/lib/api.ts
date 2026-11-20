import { can, type Action, type Role } from "@collabdocs/shared";
import type { z } from "zod";
import { auth } from "@/auth";
import { getDb } from "./db";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2025"
  );
}

/** Runs a handler and turns an HttpError into a JSON error body. Anything else is a 500 with no detail. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      // Prisma's "record to update or delete not found": the row went away between
      // the permission check and the write, which is a 404 and not a server error.
      if (isRecordNotFound(error)) {
        return json({ error: { code: "not_found", message: "Not found" } }, 404);
      }
      console.error("unhandled error in a route", error);
      return json({ error: { code: "internal", message: "Internal server error" } }, 500);
    }
  };
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads the body as text, refusing with 413 once it passes `limit` bytes. It stops
 * reading at the limit instead of buffering a body of any size and measuring it after.
 */
async function readCapped(request: Request, limit: number): Promise<string> {
  const tooLarge = () => new HttpError(413, "payload_too_large", "The body is too large");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Reads and validates a JSON body. Requires the JSON content type, which a cross-site form cannot send. */
export async function readBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send the body as application/json");
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "The body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "invalid_body", parsed.error.issues.map((i) => i.message).join("; "));
  }
  return parsed.data;
}

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * The signed-in user, or a 401. The session is a JWT, so the user is looked up
 * again: a deleted user loses access at once instead of at token expiry.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new HttpError(401, "unauthenticated", "Sign in first");
  const user = await getDb().user.findUnique({ where: { id }, select: { id: true, email: true } });
  if (!user) throw new HttpError(401, "unauthenticated", "Sign in first");
  return user;
}

/**
 * The caller's role on a document, after `can(role, action)` has allowed the
 * action. A non-member gets 404, the same answer as for a document that does
 * not exist, so that ids do not leak. A member who lacks the right gets 403.
 */
export async function requireRole(
  documentId: string,
  userId: string,
  action: Action,
): Promise<Role> {
  const membership = await getDb().membership.findUnique({
    where: { documentId_userId: { documentId, userId } },
    select: { role: true },
  });
  if (!membership) throw new HttpError(404, "not_found", "Document not found");
  if (!can(membership.role, action)) {
    throw new HttpError(403, "forbidden", `Your role does not allow this (${action})`);
  }
  return membership.role;
}

export type DocumentContext = { params: Promise<{ id: string }> };
export type MemberContext = { params: Promise<{ id: string; userId: string }> };
