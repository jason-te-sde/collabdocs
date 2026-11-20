/**
 * Colours for cursors and presence chips. All are dark enough for white text
 * (contrast of at least 4.5:1) because the cursor label is white on the colour.
 */
export const USER_COLORS = [
  "#b91c1c",
  "#1d4ed8",
  "#047857",
  "#7e22ce",
  "#b45309",
  "#0e7490",
  "#be185d",
  "#4d7c0f",
] as const;

/** A stable colour per user id, so a person keeps theirs across sessions and documents. */
export function userColor(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return USER_COLORS[(hash >>> 0) % USER_COLORS.length] ?? USER_COLORS[0];
}

/** What other people see next to a cursor: the name, or the email's local part. */
export function displayName(user: { name: string | null; email: string }): string {
  const name = user.name?.trim();
  if (name) return name;
  return user.email.split("@")[0] || user.email;
}
