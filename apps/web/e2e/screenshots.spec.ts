import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createDocument,
  documentText,
  editor,
  moveToEnd,
  newPerson,
  openDocument,
  share,
  status,
  type,
} from "./helpers";

/**
 * Regenerates the README's screenshots: `SCREENSHOTS=1 npm run test:e2e -- screenshots`.
 * Skipped otherwise, so that the normal run does not rewrite files in docs/.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate docs/images");

const IMAGES = path.resolve(__dirname, "../../../docs/images");
const VIEWPORT = { width: 1100, height: 640 };

test("screenshots: two remote cursors, the share dialog, offline", async ({ browser }) => {
  const ada = await newPerson(browser, "Ada");
  const grace = await newPerson(browser, "Grace");
  const linus = await newPerson(browser, "Linus");
  for (const person of [ada, grace, linus]) await person.page.setViewportSize(VIEWPORT);
  const id = await createDocument(ada, "Launch plan");
  await share(ada, id, grace, "editor");
  await share(ada, id, linus, "editor");
  for (const person of [ada, grace, linus]) await openDocument(person.page, id);

  await ada.page.getByRole("textbox", { name: "Document body" }).click();
  await ada.page.getByRole("button", { name: "Heading" }).click();
  // The toolbar returns focus to the editor on the next frame; typing sooner would lose a letter.
  await expect(editor(ada.page)).toBeFocused();
  await type(ada.page, "Launch plan");
  await ada.page.keyboard.press("Enter");
  await type(ada.page, "Ship the editor first, then the load tests, then the Lighthouse gate.");
  await ada.page.keyboard.press("Enter");
  await type(ada.page, "Everyone edits the same page, and each person's cursor shows here.");
  await expect.poll(() => documentText(grace.page)).toContain("Everyone edits");
  await expect.poll(() => documentText(linus.page)).toContain("Everyone edits");

  // Grace selects a word, Linus puts the cursor at the end of the last line.
  await grace.page.getByText("load tests", { exact: false }).first().dblclick();
  const last = linus.page.getByText("each person's cursor shows here.");
  const box = await last.boundingBox();
  if (!box) throw new Error("the last paragraph is not visible");
  await last.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await ada.page.getByRole("textbox", { name: "Document body" }).click();
  await ada.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await expect(
    ada.page.locator(".collaboration-carets__label", { hasText: "Grace" }),
  ).toBeVisible();
  await expect(
    ada.page.locator(".collaboration-carets__label", { hasText: "Linus" }),
  ).toBeVisible();
  await expect(ada.page.getByTestId("presence-list")).toContainText("Linus");
  await ada.page.evaluate(() => window.scrollTo(0, 0));
  await ada.page.screenshot({ path: path.join(IMAGES, "editor-two-cursors.png") });

  await ada.page.getByRole("button", { name: "Share" }).click();
  await expect(ada.page.getByRole("list", { name: "People with access" })).toContainText(
    linus.email,
  );
  await ada.page.screenshot({ path: path.join(IMAGES, "share-dialog.png") });
  await ada.page.keyboard.press("Escape");

  await grace.context.setOffline(true);
  await expect(status(grace.page)).toHaveAttribute("data-state", "offline");
  await editor(grace.page).click();
  await moveToEnd(grace.page);
  await type(grace.page, " Written offline.");
  await expect(status(grace.page)).toHaveAttribute("data-unsynced", "true");
  await grace.page.evaluate(() => window.scrollTo(0, 0));
  await grace.page.screenshot({ path: path.join(IMAGES, "offline.png") });
  await grace.context.setOffline(false);
  await expect(status(grace.page)).toHaveAttribute("data-state", "connected");

  for (const person of [ada, grace, linus]) await person.context.close();
});
