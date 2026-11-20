/** The role a user holds on one document. */
export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Every operation the system gates. REST routes and the socket server use the same list. */
export const ACTIONS = ["read", "write", "share", "delete", "change-role"] as const;
export type Action = (typeof ACTIONS)[number];

const GRANTS: Readonly<Record<Role, ReadonlySet<Action>>> = {
  owner: new Set<Action>(["read", "write", "share", "delete", "change-role"]),
  editor: new Set<Action>(["read", "write", "share"]),
  viewer: new Set<Action>(["read"]),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Roles that can be handed out through an invitation or a role change. There is one owner per document. */
export const ASSIGNABLE_ROLES = ["editor", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Whether a member with `role` may perform `action` on the document.
 *
 * A caller who is not a member has no role and must not reach this function:
 * the route answers 404 first, so that a document id does not leak.
 * An unknown role or action is denied.
 */
export function can(role: Role, action: Action): boolean {
  if (!Object.hasOwn(GRANTS, role)) return false;
  return GRANTS[role].has(action);
}
