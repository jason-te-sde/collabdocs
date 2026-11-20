import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const WEB_URL = "http://localhost:3100";
/** The directory that playwright.config.ts gives the web app's file mailer. */
const MAIL_OUTBOX_DIR = path.join(os.tmpdir(), "collabdocs-e2e-mail");
export const PASSWORD = "a long passphrase for tests";

export interface Person {
  name: string;
  email: string;
  context: BrowserContext;
  page: Page;
}

/** The token in the newest verification mail to this address. */
export async function verificationToken(email: string): Promise<string> {
  const names = (await readdir(MAIL_OUTBOX_DIR).catch(() => [])).sort().reverse();
  for (const name of names) {
    const mail = JSON.parse(await readFile(path.join(MAIL_OUTBOX_DIR, name), "utf8")) as {
      to: string;
      text: string;
    };
    const token = mail.to === email ? /verify-email\?token=([\w-]+)/.exec(mail.text)?.[1] : null;
    if (token) return token;
  }
  throw new Error(`no verification mail to ${email}`);
}

/** Confirms the address the way the emailed link's page does. */
export async function verifyEmail(page: Page, email: string): Promise<void> {
  const response = await page.request.post("/api/verify-email", {
    data: { token: await verificationToken(email) },
  });
  expect(response.status()).toBe(200);
}

/**
 * Registers a user through the API, confirms the address from the mail the app sent,
 * and signs in through the sign-in form, in a fresh browser context. Pass
 * `verified: false` to leave the address unconfirmed.
 */
export async function newPerson(
  browser: Browser,
  name: string,
  { verified = true }: { verified?: boolean } = {},
): Promise<Person> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const context = await browser.newContext({ baseURL: WEB_URL });
  const page = await context.newPage();
  const registered = await page.request.post("/api/register", {
    data: { email, password: PASSWORD, name },
  });
  expect(registered.status()).toBe(201);
  if (verified) await verifyEmail(page, email);
  await signIn(page, email);
  return { name, email, context, page };
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/documents");
}

export async function createDocument(owner: Person, title: string): Promise<string> {
  const response = await owner.page.request.post("/api/documents", { data: { title } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

export async function share(
  owner: Person,
  documentId: string,
  invitee: Person,
  role: "editor" | "viewer",
): Promise<void> {
  const response = await owner.page.request.post(`/api/documents/${documentId}/memberships`, {
    data: { email: invitee.email, role },
  });
  expect(response.status()).toBe(201);
}

export const editor = (page: Page) => page.getByRole("textbox", { name: "Document body" });
export const status = (page: Page) => page.getByTestId("connection-status");

/** Opens the document and waits until the editor shows and the server's state has arrived. */
export async function openDocument(page: Page, documentId: string): Promise<void> {
  await page.goto(`/documents/${documentId}`);
  await expect(editor(page)).toBeVisible();
  await expect(status(page)).toHaveAttribute("data-state", "connected");
}

/**
 * The document's text, one line per paragraph. Remote cursor labels live
 * inside the editor and hold names, so they are removed from a copy first.
 */
export async function documentText(page: Page): Promise<string> {
  return editor(page).evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".collaboration-carets__caret").forEach((caret) => caret.remove());
    return [...copy.querySelectorAll("p")].map((p) => p.textContent ?? "").join("\n");
  });
}

export async function moveToEnd(page: Page): Promise<void> {
  await editor(page).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
}

export async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 25 });
}
