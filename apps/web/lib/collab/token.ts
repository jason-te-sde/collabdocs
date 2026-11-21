import { isRole } from "@collabdocs/shared/permissions";
import { CollabAccessError, type CollabToken } from "./provider";

/** Asks the web app for a token that opens one document on the collab server. */
export async function requestCollabToken(documentId: string): Promise<CollabToken> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/collab-token`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new CollabAccessError(response.status);
  }
  if (!response.ok) throw new Error(`token request failed (${response.status})`);
  const body = (await response.json()) as { token?: unknown; role?: unknown };
  if (typeof body.token !== "string" || !isRole(body.role)) {
    throw new Error("token response is malformed");
  }
  return { token: body.token, role: body.role };
}
