import type { AssignableRole, Role } from "@collabdocs/shared/permissions";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Calls a JSON route of this app. Throws ApiError with the route's own message on a non-2xx answer. */
export async function api<T = void>(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // not JSON: handled below
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `The request failed (${response.status})`,
    );
  }
  return payload as T;
}

export interface DocumentSummary {
  id: string;
  title: string;
  ownerId: string;
  role: Role;
  updatedAt: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
}

export const listDocuments = () => api<{ documents: DocumentSummary[] }>("/api/documents");

export const createDocument = (title: string) =>
  api<{ document: DocumentSummary }>("/api/documents", { method: "POST", body: { title } });

export const getDocument = (id: string) =>
  api<{ document: DocumentSummary }>(`/api/documents/${encodeURIComponent(id)}`);

export const renameDocument = (id: string, title: string) =>
  api<{ document: DocumentSummary }>(`/api/documents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { title },
  });

export const listMembers = (id: string) =>
  api<{ memberships: Member[] }>(`/api/documents/${encodeURIComponent(id)}/memberships`);

export const inviteMember = (id: string, email: string, role: AssignableRole) =>
  api<{ membership: Member }>(`/api/documents/${encodeURIComponent(id)}/memberships`, {
    method: "POST",
    body: { email, role },
  });

export const changeMemberRole = (id: string, userId: string, role: AssignableRole) =>
  api(`/api/documents/${encodeURIComponent(id)}/memberships/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: { role },
  });

export const removeMember = (id: string, userId: string) =>
  api(`/api/documents/${encodeURIComponent(id)}/memberships/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
