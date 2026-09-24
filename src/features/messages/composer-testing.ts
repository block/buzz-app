import { afterEach, beforeEach } from "vitest";

/** jsdom has no layout/hit testing. Supply only the browser APIs ProseMirror
 * needs to edit; geometry and native selection remain browser-test contracts. */
export function composerDOMFixture() {
  const rect = new DOMRect(0, 0, 100, 20);
  const originals = [
    [Range.prototype, "getClientRects"],
    [Range.prototype, "getBoundingClientRect"],
    [document, "elementFromPoint"],
    [window, "scrollBy"],
  ] as const;
  const descriptors = originals.map(([target, name]) =>
    Object.getOwnPropertyDescriptor(target, name),
  );
  beforeEach(() => {
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [rect],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rect,
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => null,
    });
  });
  afterEach(() => {
    originals.forEach(([target, name], index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    });
  });
}
