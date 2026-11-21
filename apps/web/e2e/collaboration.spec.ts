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

test("two people typing at once converge on the same text with both inputs", async ({
  browser,
}) => {
  const owner = await newPerson(browser, "Olive");
  const writer = await newPerson(browser, "Wren");
  const id = await createDocument(owner, "Concurrent typing");
  await share(owner, id, writer, "editor");
  await openDocument(owner.page, id);
  await openDocument(writer.page, id);

  // Lower case from one side, upper case from the other, so each side's input can be told apart.
  const fromOwner = "thequickbrownfoxjumpsoverthelazydog";
  const fromWriter = "PACKMYBOXWITHFIVEDOZENLIQUORJUGS";
  await owner.page.getByRole("textbox", { name: "Document body" }).click();
  await writer.page.getByRole("textbox", { name: "Document body" }).click();
  await Promise.all([type(owner.page, fromOwner), type(writer.page, fromWriter)]);

  await expect
    .poll(async () => (await documentText(owner.page)) === (await documentText(writer.page)))
    .toBe(true);
  // Each side's own characters, in order, are exactly what that side typed.
  const merged = await documentText(owner.page);
  expect(merged.replace(/[^a-z]/g, "")).toBe(fromOwner);
  expect(merged.replace(/[^A-Z]/g, "")).toBe(fromWriter);
  await owner.context.close();
  await writer.context.close();
});

test("a viewer sees edits live but cannot type, and sends nothing", async ({ browser }) => {
  const owner = await newPerson(browser, "Olive");
  const viewer = await newPerson(browser, "Vera");
  const id = await createDocument(owner, "View only");
  await share(owner, id, viewer, "viewer");

  const frames: string[] = [];
  viewer.page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      if (typeof frame.payload === "string") frames.push(frame.payload);
    });
  });
  await openDocument(owner.page, id);
  await openDocument(viewer.page, id);
  await expect(viewer.page.getByTestId("view-only")).toBeVisible();
  await expect(editor(viewer.page)).toHaveAttribute("contenteditable", "false");
  await expect(viewer.page.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(viewer.page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);

  await owner.page.getByRole("textbox", { name: "Document body" }).click();
  await type(owner.page, "written by the owner");
  await expect.poll(() => documentText(viewer.page)).toBe("written by the owner");

  const updatesBefore = frames.filter((f) => f.includes('"sync"')).length;
  await editor(viewer.page).click();
  await viewer.page.keyboard.type("the viewer tries to type");
  await viewer.page.keyboard.press("Backspace");
  // Give a wrongly sent update time to arrive.
  await owner.page.waitForTimeout(1000);
  expect(await documentText(viewer.page)).toBe("written by the owner");
  expect(await documentText(owner.page)).toBe("written by the owner");
  expect(frames.filter((f) => f.includes('"sync"')).length).toBe(updatesBefore);
  await owner.context.close();
  await viewer.context.close();
});

test("remote cursors, selections and presence appear with the user's name", async ({ browser }) => {
  const owner = await newPerson(browser, "Olive");
  const writer = await newPerson(browser, "Wren");
  const id = await createDocument(owner, "Cursors");
  await share(owner, id, writer, "editor");
  await openDocument(owner.page, id);
  await openDocument(writer.page, id);

  await expect(owner.page.getByTestId("presence-list")).toContainText("Wren");
  await expect(owner.page.getByTestId("presence-list")).toContainText("Olive (you)");
  await expect(writer.page.getByTestId("presence-list")).toContainText("Olive");

  await owner.page.getByRole("textbox", { name: "Document body" }).click();
  await type(owner.page, "select some of this text");
  await writer.page.getByRole("textbox", { name: "Document body" }).click();
  await expect(
    owner.page.locator(".collaboration-carets__label", { hasText: "Wren" }),
  ).toBeVisible();

  // Wren selects the last few characters; Olive sees them highlighted.
  await moveToEnd(writer.page);
  for (let i = 0; i < 4; i++) await writer.page.keyboard.press("Shift+ArrowLeft");
  await expect(owner.page.locator(".ProseMirror-yjs-selection").first()).toBeVisible();

  await writer.context.close();
  await expect(owner.page.getByTestId("presence-list")).not.toContainText("Wren");
  await owner.context.close();
});

test("a member who goes offline keeps typing, and the merge on reconnect loses nothing", async ({
  browser,
}) => {
  const owner = await newPerson(browser, "Olive");
  const writer = await newPerson(browser, "Wren");
  const id = await createDocument(owner, "Offline merge");
  await share(owner, id, writer, "editor");
  await openDocument(owner.page, id);
  await openDocument(writer.page, id);

  // One shared paragraph to type into. Its characters belong to neither side's alphabet.
  await owner.page.getByRole("textbox", { name: "Document body" }).click();
  await type(owner.page, "###");
  await expect.poll(() => documentText(writer.page)).toBe("###");

  await writer.context.setOffline(true);
  await expect(status(writer.page)).toHaveAttribute("data-state", "offline");

  const fromOwner = "owner types while online 0123456789";
  const fromWriter = "WRITER_TYPES_WHILE_OFFLINE";
  await moveToEnd(owner.page);
  await moveToEnd(writer.page);
  await Promise.all([type(owner.page, fromOwner), type(writer.page, fromWriter)]);

  // Offline, the writer's edits stay on its side and the page says they are unsynced.
  await expect(status(writer.page)).toHaveAttribute("data-unsynced", "true");
  expect(await documentText(owner.page)).not.toContain("WRITER");
  expect(await documentText(writer.page)).toContain(fromWriter);

  await writer.context.setOffline(false);
  await expect(status(writer.page)).toHaveAttribute("data-state", "connected");
  await expect(status(writer.page)).toHaveAttribute("data-unsynced", "false");

  await expect
    .poll(async () => (await documentText(owner.page)) === (await documentText(writer.page)))
    .toBe(true);
  const merged = await documentText(owner.page);
  // Keeping only each side's own characters gives back exactly what that side typed, in order:
  // nothing lost, nothing duplicated, and the shared "###" is still there once.
  expect(merged.replace(/[^a-z0-9 ]/g, "")).toBe(fromOwner);
  expect(merged.replace(/[^A-Z_]/g, "")).toBe(fromWriter);
  expect(merged.replaceAll(/[^#]/g, "")).toBe("###");
  expect(merged).toHaveLength(3 + fromOwner.length + fromWriter.length);
  await owner.context.close();
  await writer.context.close();
});

test("edits made while the server is unreachable survive a reload and sync afterwards", async ({
  browser,
}) => {
  const owner = await newPerson(browser, "Olive");
  const writer = await newPerson(browser, "Wren");
  const id = await createDocument(owner, "Reload keeps edits");
  await share(owner, id, writer, "editor");

  // The writer's page reaches the collab server only while `blocked` is false. While it
  // is true, the "server" answers the transport handshake and then drops the connection.
  let blocked = false;
  await writer.page.routeWebSocket(/:4100\//, (socket) => {
    if (!blocked) {
      socket.connectToServer();
      return;
    }
    socket.send('0{"sid":"blocked","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    void socket.close();
  });
  await openDocument(owner.page, id);
  await openDocument(writer.page, id);

  await writer.context.setOffline(true);
  await expect(status(writer.page)).toHaveAttribute("data-state", "offline");
  await writer.page.getByRole("textbox", { name: "Document body" }).click();
  await type(writer.page, "kept on this device");

  blocked = true;
  await writer.context.setOffline(false);
  await writer.page.reload();
  await expect(editor(writer.page)).toBeVisible();
  await expect.poll(() => documentText(writer.page)).toBe("kept on this device");
  await expect(status(writer.page)).not.toHaveAttribute("data-state", "connected");
  expect(await documentText(owner.page)).toBe("");

  blocked = false;
  await expect(status(writer.page)).toHaveAttribute("data-state", "connected", { timeout: 20_000 });
  await expect.poll(() => documentText(owner.page)).toBe("kept on this device");
  await owner.context.close();
  await writer.context.close();
});
