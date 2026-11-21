import { getMailer } from "./mailer";
import { appUrl } from "./verification";

export interface InvitationMail {
  to: string;
  documentTitle: string;
  inviter: string;
  role: string;
  /** Whether an account exists for the address. Only the words of the message differ. */
  hasAccount: boolean;
}

/**
 * Text that somebody else chose (a document title, a display name), made safe to put in a
 * message to a third party: control characters and line breaks become spaces, runs of
 * blanks one space, and it is cut to `max` characters.
 */
export function plainText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Tells the owner of an address that they were invited. The details of the invitation go
 * here, to the address, and not into the answer to the inviter: the answer is the same
 * whether or not the address has an account. The message carries no link that grants
 * access; the invitation applies once the address is verified and signed in.
 */
export async function sendInvitationEmail(mail: InvitationMail): Promise<void> {
  const steps = mail.hasAccount
    ? `To see it, sign in at ${appUrl()}/sign-in with this address. If you have not confirmed the address yet, use the link in the confirmation email first.`
    : `To see it, create an account at ${appUrl()}/register with this address and confirm it with the link we send.`;
  // The subject is fixed: neither the title nor the name of the inviter, both chosen by the
  // sender, appear in it. In the body they are flattened to one short line each.
  const inviter = plainText(mail.inviter, 60);
  const title = plainText(mail.documentTitle, 80);
  await getMailer().send({
    to: mail.to,
    subject: "You were invited to a document on CollabDocs",
    text: [
      `${inviter} invited you to "${title}" as ${mail.role}.`,
      "",
      steps,
      "",
      "The document appears in your list once your address is confirmed. If you were not expecting this, ignore this message.",
    ].join("\n"),
  });
}
