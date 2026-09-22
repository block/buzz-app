import { act } from "@testing-library/react";
import type { ComposerInputElement } from "./composer-dom";

/** jsdom has no layout; browser suites own caret geometry and pointer placement. */
export function installComposerGeometry() {
  const originalRects = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getClientRects",
  );
  const originalBounds = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect",
  );
  const originalPoint = Object.getOwnPropertyDescriptor(
    document,
    "elementFromPoint",
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  return () => {
    for (const [target, key, descriptor] of [
      [Range.prototype, "getClientRects", originalRects],
      [Range.prototype, "getBoundingClientRect", originalBounds],
      [document, "elementFromPoint", originalPoint],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  };
}

/** Real document transaction, not a DOM mutation pretending to be editor input. */
export function fillComposer(element: HTMLElement, text: string) {
  const owner = (element as ComposerInputElement).richComposer;
  if (!owner) throw new Error("Missing rich editor");
  act(() => {
    element.focus();
    owner.editor.commands.selectAll();
    if (text) owner.editor.commands.insertContent({ type: "text", text });
    else owner.editor.commands.deleteSelection();
    owner.setEditingSelection(text.length);
  });
}
