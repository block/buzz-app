(request) => {
  try {
    const visible = (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible" &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]');
    if (request.action === "observe") {
      return {
        url: location.href,
        title: document.title,
        text: document.body.innerText.slice(0, 20000),
        elements: [
          ...document.querySelectorAll("a, button, input, textarea, select"),
        ]
          .filter(visible)
          .slice(0, 100)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type"),
            id: element.id,
            name: element.getAttribute("name"),
            label: (
              element.getAttribute("aria-label") ||
              element.innerText ||
              element.labels?.[0]?.innerText ||
              ""
            ).slice(0, 200),
          })),
        truncated: document.body.innerText.length > 20000,
      };
    }
    const matches = [...document.querySelectorAll(request.selector)].filter(
      visible,
    );
    if (matches.length !== 1)
      throw new Error(
        `Selector matches ${matches.length} visible elements; use a unique selector`,
      );
    const element = matches[0];
    if (
      element.matches(":disabled") ||
      element.closest('[aria-disabled="true"]')
    )
      throw new Error("Element is disabled");
    if (request.action === "click") {
      if (!(element instanceof HTMLElement))
        throw new Error("Element cannot be clicked");
      if (element instanceof HTMLInputElement && element.type === "file")
        throw new Error("File uploads are unavailable");
      element.click();
    } else if (request.action === "fill") {
      if (
        !(
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) ||
        (element instanceof HTMLInputElement &&
          !["text", "search", "email", "url", "tel", "number"].includes(
            element.type,
          ))
      )
        throw new Error(
          "Fill requires a text field; password and file inputs are unavailable",
        );
      if (element.readOnly) throw new Error("Field is read-only");
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        element,
        request.text,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else throw new Error("Unknown browser action");
    return { ok: true };
  } catch (error) {
    return { error: String(error.message || error).slice(0, 1000) };
  }
};
