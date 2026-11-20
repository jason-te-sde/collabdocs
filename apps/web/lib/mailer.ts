import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** What the app needs from an email service: send one message, or throw. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development: prints the message, so the verification link can be copied from the terminal. */
export class ConsoleMailer implements Mailer {
  send(message: MailMessage): Promise<void> {
    process.stdout.write(
      `\n--- mail to ${message.to} ---\nSubject: ${message.subject}\n\n${message.text}\n---\n`,
    );
    return Promise.resolve();
  }
}

/** Tests and e2e: one JSON file per message in a directory the test can read. */
export class FileMailer implements Mailer {
  constructor(private readonly directory: string) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    await writeFile(path.join(this.directory, name), JSON.stringify(message, null, 2));
  }
}

/**
 * Picks the mailer from MAIL_TRANSPORT: "console" or "file" (with MAIL_OUTBOX_DIR).
 *
 * Neither delivers anything, and "console" puts verification links in the log, so
 * outside development the transport must be chosen on purpose: unset, it is
 * "console" only when NODE_ENV is not "production"; in production the app refuses
 * to send until a transport is configured.
 *
 * To send real mail, implement `Mailer` for your provider (an HTTP API client or
 * SMTP; `send` must throw when the provider refuses the message), add a case here
 * that reads its settings from the environment, and set MAIL_TRANSPORT to its name.
 * Nothing else in the app changes: callers only use `getMailer().send(...)`.
 */
export function createMailer(env: Record<string, string | undefined> = process.env): Mailer {
  const transport = env.MAIL_TRANSPORT || (env.NODE_ENV === "production" ? "" : "console");
  switch (transport) {
    case "console":
      return new ConsoleMailer();
    case "file": {
      if (!env.MAIL_OUTBOX_DIR) throw new Error("MAIL_OUTBOX_DIR is not set");
      return new FileMailer(env.MAIL_OUTBOX_DIR);
    }
    case "":
      throw new Error("MAIL_TRANSPORT is not configured; the app cannot send email");
    default:
      throw new Error(`unknown MAIL_TRANSPORT "${transport}"`);
  }
}

export function getMailer(): Mailer {
  return createMailer();
}
