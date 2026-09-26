// @vitest-environment jsdom
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { copyImageToClipboard, supportsImageCopy } from "./image-copy";

class TestClipboardItem {
  readonly items: Record<string, Promise<Blob>>;
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items;
  }
}

type ClipboardWrite = Mock<(items: TestClipboardItem[]) => Promise<void>>;

function stubClipboard(write: ClipboardWrite = vi.fn(async () => {})) {
  vi.stubGlobal("navigator", { clipboard: { write } });
  return write;
}

function stubClipboardItem() {
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
}

function loadedImage() {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 12 },
    naturalHeight: { configurable: true, value: 8 },
  });
  return image;
}

function stubCanvas(toBlob: HTMLCanvasElement["toBlob"]) {
  const drawImage = vi.fn();
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    const element = createElement(tagName);
    if (tagName === "canvas") {
      vi.spyOn(element as HTMLCanvasElement, "getContext").mockReturnValue({
        drawImage,
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(element as HTMLCanvasElement, "toBlob").mockImplementation(
        toBlob,
      );
    }
    return element;
  });
  return { drawImage };
}

function firstClipboardItem(write: ClipboardWrite) {
  const item = write.mock.calls[0]?.[0][0];
  if (!item) throw new Error("Missing clipboard item");
  return item;
}

function pngPromise(item: TestClipboardItem) {
  const png = item.items["image/png"];
  if (!png) throw new Error("Missing PNG item");
  return png;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("detects image clipboard support", () => {
  stubClipboardItem();
  stubClipboard();
  expect(supportsImageCopy()).toBe(true);

  vi.stubGlobal("ClipboardItem", undefined);
  expect(supportsImageCopy()).toBe(false);

  stubClipboardItem();
  vi.stubGlobal("navigator", { clipboard: {} });
  expect(supportsImageCopy()).toBe(false);
});

it("calls clipboard.write before PNG encoding settles", async () => {
  stubClipboardItem();
  let encode!: (blob: Blob) => void;
  stubCanvas((callback) => {
    encode = (blob) => callback(blob);
  });
  const write = stubClipboard(vi.fn(async () => {}));

  const result = copyImageToClipboard(loadedImage());

  expect(write).toHaveBeenCalledTimes(1);
  const item = firstClipboardItem(write);
  let encoded = false;
  pngPromise(item).then(() => {
    encoded = true;
  });
  await Promise.resolve();
  expect(encoded).toBe(false);

  const blob = new Blob(["png"], { type: "image/png" });
  encode(blob);
  await expect(pngPromise(item)).resolves.toBe(blob);
  await expect(result).resolves.toBeUndefined();
});

it("propagates clipboard permission rejection", async () => {
  stubClipboardItem();
  stubCanvas((callback) => callback(new Blob(["png"], { type: "image/png" })));
  const denied = new Error("denied");
  stubClipboard(vi.fn(async () => Promise.reject(denied)));

  await expect(copyImageToClipboard(loadedImage())).rejects.toBe(denied);
});

it("propagates null PNG encoding failure", async () => {
  stubClipboardItem();
  stubCanvas((callback) => callback(null));
  const write = stubClipboard(vi.fn(async () => {}));

  await expect(copyImageToClipboard(loadedImage())).rejects.toThrow(
    "Could not encode image",
  );
  const item = firstClipboardItem(write);
  await expect(pngPromise(item)).rejects.toThrow("Could not encode image");
});

it("propagates unloaded image failures", async () => {
  stubClipboardItem();
  stubCanvas((callback) => callback(new Blob(["png"], { type: "image/png" })));
  const write = stubClipboard(vi.fn(async () => {}));
  const image = loadedImage();
  Object.defineProperties(image, {
    complete: { configurable: true, value: false },
    naturalWidth: { configurable: true, value: 0 },
  });

  await expect(copyImageToClipboard(image)).rejects.toThrow(
    "Image is not loaded",
  );
  const item = firstClipboardItem(write);
  await expect(pngPromise(item)).rejects.toThrow("Image is not loaded");
});
