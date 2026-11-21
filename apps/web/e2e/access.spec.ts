import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createDocument,
  documentText,
  editor,
  newPerson,
  PASSWORD,
  openDocument,
  share,
  status,
  type,
  verificationToken,
} from "./helpers";

test("a removed member is disconnected, loses the page and the local copy", async ({ browser }) => {
  const owner = await newPerson(browser, "Olive");
  const writer = await newPerson(browser, "Wren");
  const id = await createDocument(owner, "Removal");
  await share(owner, id, writer, "editor");
  await openDocument(owner.page, id);
  await openDocument(writer.page, id);
  await owner.page.getByRole("textbox", { name: "Document body" }).click();
  await type(owner.page, "secret plans");
  await expect.poll(() => documentText(writer.page)).toBe("secret plans");

  // The owner removes the member in the share dialog.
  await owner.page.getByRole("button", { name: "Share" }).click();
  await owner.page.getByRole("button", { name: `Remove ${writer.email}` }).click();
  await expect(owner.page.getByRole("button", { name: `Remove ${writer.email}` })).toHaveCount(0);

  await expect(
    writer.page.getByRole("heading", { name: "You do not have access to this document" }),
  ).toBeVisible();
  await expect(editor(writer.page)).toHaveCount(0);
  await expect
    .poll(() =>
      writer.page.evaluate(async () =>
        (await indexedDB.databases()).some((db) => db.name?.includes("collabdocs:")),
      ),
    )
    .toBe(false);

  // The page stays gone after a reload, and the document is not in the list.
  await writer.page.reload();
  await expect(
    writer.page.getByRole("heading", { name: "You do not have access to this document" }),
  ).toBeVisible();
  await writer.page.goto("/documents");
  await expect(writer.page.getByText("Nobody has shared a document with you yet.")).toBeVisible();

  // The owner's editor is unaffected.
  await expect(status(owner.page)).toHaveAttribute("data-state", "connected");
  await owner.context.close();
  await writer.context.close();
});

test("demoting an editor to viewer makes their editor read-only without a reload", async ({
  browser,
}) => {
  const owner = await newPerson(browser, "Olive");
  const writer = await newPerson(browser, "Wren");
  const id = await createDocument(owner, "Demotion");
  await share(owner, id, writer, "editor");
  await openDocument(owner.page, id);
  await openDocument(writer.page, id);
  await expect(editor(writer.page)).toHaveAttribute("contenteditable", "true");

  await owner.page.getByRole("button", { name: "Share" }).click();
  await owner.page.getByLabel(`Role for ${writer.email}`).selectOption("viewer");

  await expect(writer.page.getByTestId("view-only")).toBeVisible();
  await expect(editor(writer.page)).toHaveAttribute("contenteditable", "false");
  await expect(status(writer.page)).toHaveAttribute("data-state", "connected");
  await owner.context.close();
  await writer.context.close();
});

test("sign up, create, rename and share a document through the pages", async ({ browser }) => {
  const owner = await newPerson(browser, "Olive");
  const guest = await newPerson(browser, "Gus");

  await owner.page.getByLabel("New document title").fill("Quarterly plan");
  await owner.page.getByRole("button", { name: "Create document" }).click();
  await owner.page.waitForURL(/\/documents\/[^/]+$/);
  await expect(owner.page.getByRole("heading", { level: 1, name: "Quarterly plan" })).toBeVisible();

  await owner.page.getByRole("button", { name: "Share" }).click();
  await owner.page.getByLabel("Email").fill(guest.email);
  await owner.page.getByRole("button", { name: "Invite" }).click();
  await expect(owner.page.getByText(`Invitation sent to ${guest.email}`)).toBeVisible();
  await expect(
    owner.page.getByRole("list", { name: "Pending invitations" }).getByText(guest.email),
  ).toBeVisible();
  await owner.page.keyboard.press("Escape");

  await owner.page.goto("/documents");
  await owner.page.getByRole("button", { name: "Rename Quarterly plan" }).click();
  await owner.page.getByRole("dialog").getByLabel("Title").fill("Quarterly plan v2");
  await owner.page.getByRole("button", { name: "Save" }).click();
  await expect(owner.page.getByRole("link", { name: "Quarterly plan v2" })).toBeVisible();

  await guest.page.goto("/documents");
  const shared = guest.page.getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("link", { name: "Quarterly plan v2" })).toBeVisible();
  await expect(shared).toContainText("Can edit");

  // A wrong password is refused, and the page says so.
  const stranger = await browser.newContext({ baseURL: "http://localhost:3100" });
  const page = await stranger.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The email or the password is wrong.")).toBeVisible();
  await page.goto("/documents");
  await expect(page).toHaveURL(/\/sign-in$/);
  await stranger.close();

  // Registration through the form signs the new user in.
  const newcomer = await browser.newContext({ baseURL: "http://localhost:3100" });
  const signup = await newcomer.newPage();
  await signup.goto("/register");
  await signup.getByLabel("Name").fill("Rae");
  await signup.getByLabel("Email").fill(`rae-${randomUUID().slice(0, 8)}@example.test`);
  await signup.getByLabel("Password").fill(PASSWORD);
  await signup.getByRole("button", { name: "Create account" }).click();
  await signup.waitForURL("**/documents");
  await expect(signup.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  await newcomer.close();
  await owner.context.close();
  await guest.context.close();
});

test("an invitation to an unconfirmed address waits until the address is confirmed", async ({
  browser,
}) => {
  const owner = await newPerson(browser, "Olive");
  const guest = await newPerson(browser, "Gwen", { verified: false });
  const id = await createDocument(owner, "Held back");

  await owner.page.goto(`/documents/${id}`);
  await owner.page.getByRole("button", { name: "Share" }).click();
  await owner.page.getByLabel("Email").fill(guest.email);
  await owner.page.getByRole("button", { name: "Invite" }).click();
  await expect(owner.page.getByText(`Invitation sent to ${guest.email}`)).toBeVisible();
  await expect(
    owner.page.getByRole("list", { name: "Pending invitations" }).getByText(guest.email),
  ).toBeVisible();

  // The guest is signed in, is told to confirm, and has no access yet.
  await guest.page.goto("/documents");
  await expect(guest.page.getByText("Confirm your email address")).toBeVisible();
  await guest.page.goto(`/documents/${id}`);
  await expect(
    guest.page.getByRole("heading", { name: "You do not have access to this document" }),
  ).toBeVisible();

  // The link in the mail opens a page whose button confirms the address.
  await guest.page.goto(`/verify-email?token=${await verificationToken(guest.email)}`);
  await guest.page.getByRole("button", { name: "Confirm email address" }).click();
  await expect(guest.page.getByText("Your email address is confirmed")).toBeVisible();

  await openDocument(guest.page, id);
  await expect(guest.page.getByText("Confirm your email address")).toHaveCount(0);
  await owner.context.close();
  await guest.context.close();
});
