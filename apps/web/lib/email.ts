/** Emails are compared and stored in lower case; the database enforces it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
