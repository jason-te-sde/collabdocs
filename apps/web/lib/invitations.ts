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
 * Tells the owner of an address that they were invited. The details of the invitation go
 * here, to the address, and not into the answer to the inviter: the answer is the same
 * whether or not the address has an account. The message carries no link that grants
 * access; the invitation applies once the address is verified and signed in.
 */
export async function sendInvitationEmail(mail: InvitationMail): Promise<void> {
  const steps = mail.hasAccount
    ? `To see it, sign in at ${appUrl()}/sign-in with this address. If you have not confirmed the address yet, use the link in the confirmation email first.`
    : `To see it, create an account at ${appUrl()}/register with this address and confirm it with the link we send.`;
  await getMailer().send({
    to: mail.to,
    subject: `${mail.inviter} invited you to a document on CollabDocs`,
    text: [
      `${mail.inviter} invited you to "${mail.documentTitle}" as ${mail.role}.`,
      "",
      steps,
      "",
      "The document appears in your list once your address is confirmed. If you were not expecting this, ignore this message.",
    ].join("\n"),
  });
}
