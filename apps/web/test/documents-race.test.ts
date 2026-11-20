import { describe, expect, it, vi } from "vitest";
import {
  DELETE as deleteDocument,
  GET as getDocument,
  PATCH as renameDocument,
} from "@/app/api/documents/[id]/route";
import * as api from "@/lib/api";
import type * as ApiModule from "@/lib/api";
import { getDb } from "@/lib/db";
import { ctx, fixture, jsonRequest, signInAs } from "./helpers";

// The permission check passes, and the document is deleted before the route reads or writes it.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, requireRole: vi.fn(actual.requireRole) };
});

async function deletedAfterTheRoleCheck(documentId: string): Promise<void> {
  const actual = await vi.importActual<typeof ApiModule>("@/lib/api");
  vi.mocked(api.requireRole).mockImplementationOnce(async (...args) => {
    const role = await actual.requireRole(...args);
    await getDb().document.delete({ where: { id: documentId } });
    return role;
  });
}

describe("a document deleted while a request is in flight", () => {
  it("answers GET with 404, not 500", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await deletedAfterTheRoleCheck(f.documentId);
    const response = await getDocument(jsonRequest("GET"), ctx({ id: f.documentId }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("answers PATCH with 404, not 500", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await deletedAfterTheRoleCheck(f.documentId);
    const response = await renameDocument(
      jsonRequest("PATCH", { title: "New" }),
      ctx({ id: f.documentId }),
    );
    expect(response.status).toBe(404);
  });

  it("answers DELETE with 404, not 500", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await deletedAfterTheRoleCheck(f.documentId);
    const response = await deleteDocument(jsonRequest("DELETE"), ctx({ id: f.documentId }));
    expect(response.status).toBe(404);
  });
});
