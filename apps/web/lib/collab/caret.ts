/**
 * Builds the element that marks another person's cursor inside the editor.
 *
 * The marker sits in the middle of the document's text, so a screen reader that
 * walks the text would read every collaborator's name in the middle of a
 * sentence. It is hidden from assistive technology (the presence list above
 * the editor names who is here) and is not editable or selectable.
 */
export function renderCaret(user: Record<string, unknown>): HTMLElement {
  const color =
    typeof user.color === "string" && /^#[0-9a-fA-F]{6}$/.test(user.color)
      ? user.color
      : "transparent";
  const name = typeof user.name === "string" ? user.name : "";

  const caret = document.createElement("span");
  caret.classList.add("collaboration-carets__caret");
  caret.style.borderColor = color;
  caret.setAttribute("aria-hidden", "true");

  const label = document.createElement("div");
  label.classList.add("collaboration-carets__label");
  label.style.backgroundColor = color;
  label.append(document.createTextNode(name));
  caret.append(label);
  return caret;
}
