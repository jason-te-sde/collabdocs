// LHCI puppeteer script: runs once per URL, before Lighthouse visits it, in the
// browser that Lighthouse then uses (so cookies carry over; the config turns off
// the storage reset that would drop them).
//
// - The sign-in page is measured signed out: cookies are cleared first.
// - Every other page is measured signed in, with the session cookie that
//   seed.mjs wrote.
// - The editor page is also given text to show, typed once through the real
//   editor, so that the measured page is not an empty document.
const { readFileSync } = require("node:fs");
const path = require("node:path");

const seed = JSON.parse(
  readFileSync(path.join(__dirname, "../../.lighthouseci-seed.json"), "utf8"),
);

const PARAGRAPHS = [
  "Launch plan",
  "Ship the editor first, then the load tests, then the Lighthouse gate.",
  "Everyone edits the same page, and each person's cursor shows here.",
  "Roles are checked on every request and every socket event, so a viewer can read along but not change a word.",
  "Edits made offline are kept on the device and merged when the connection returns.",
];

module.exports = async (browser, { url }) => {
  const page = await browser.newPage();
  try {
    const { pathname } = new URL(url);
    await page.deleteCookie(...(await page.cookies(url)));
    if (pathname === "/sign-in") return;

    await page.setCookie({ ...seed.cookie, url, httpOnly: true, sameSite: "Lax" });
    if (!pathname.startsWith("/documents/")) return;

    await page.goto(url, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="connection-status"][data-state="connected"]');
    const textbox = '[role="textbox"][aria-label="Document body"]';
    // Text is typed once: the seeded document keeps it between the runs of one job.
    if ((await page.$eval(textbox, (node) => node.textContent ?? "")).length > 0) return;
    await page.click(textbox);
    for (const paragraph of PARAGRAPHS) {
      await page.keyboard.type(paragraph);
      await page.keyboard.press("Enter");
    }
    // The server stores an update shortly after it is accepted; wait for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    await page.close();
  }
};
