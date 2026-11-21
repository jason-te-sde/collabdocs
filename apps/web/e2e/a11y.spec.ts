import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createDocument, editor, newPerson, openDocument, share, type } from "./helpers";

/**
 * Automated accessibility checks with axe-core on the pages that the Lighthouse
 * gate measures (sign-in, the document list, the editor) and on the open share
 * dialog. A serious or critical violation fails the test; lesser ones are
 * attached to the report so they stay visible.
 */

async function seriousViolations(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  const summary = (violations: typeof results.violations) =>
    violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  const minor = results.violations.filter((violation) => !blocking.includes(violation));
  if (minor.length > 0) {
    await test.info().attach(`${name}-minor-violations`, {
      body: JSON.stringify(summary(minor), null, 2),
      contentType: "application/json",
    });
  }
  return summary(blocking);
}

test("the sign-in page has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await seriousViolations(page, "sign-in")).toEqual([]);
});

test("the document list has no serious or critical accessibility violations", async ({
  browser,
}) => {
  const person = await newPerson(browser, "Axel");
  await createDocument(person, "Accessibility check");
  await person.page.goto("/documents");
  await expect(person.page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(person.page.getByText("Accessibility check")).toBeVisible();
  expect(await seriousViolations(person.page, "documents")).toEqual([]);
  await person.context.close();
});

test("the editor and the share dialog have no serious or critical accessibility violations", async ({
  browser,
}) => {
  const person = await newPerson(browser, "Axel");
  const second = await newPerson(browser, "Bea");
  const id = await createDocument(person, "Accessibility check");
  await openDocument(person.page, id);
  await share(person, id, second, "editor");
  await openDocument(second.page, id);
  // A second person's cursor is in the first one's page while axe runs.
  await editor(second.page).click();
  await type(second.page, "Hello");
  await expect(person.page.locator(".collaboration-carets__label")).toBeVisible();
  // The marker is not read out in the middle of the text.
  await expect(person.page.locator(".collaboration-carets__caret")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(await seriousViolations(person.page, "editor")).toEqual([]);

  await person.page.getByRole("button", { name: "Share" }).click();
  await expect(person.page.getByRole("dialog", { name: "Share this document" })).toBeVisible();
  expect(await seriousViolations(person.page, "share-dialog")).toEqual([]);
  await person.context.close();
  await second.context.close();
});
