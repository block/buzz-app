import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readUnexposedClipboardImage } from "./native-clipboard-image";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const native = vi.mocked(invoke);
const desktop = vi.mocked(isTauri);

function paste(
  types = ["Files"],
  items: Pick<DataTransferItem, "kind" | "type">[] = [],
  files: File[] = [],
  isTrusted = true,
) {
  return {
    isTrusted,
    clipboardData: { types, items, files } as unknown as DataTransfer,
  };
}

beforeEach(() => {
  desktop.mockReturnValue(true);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it.each([
  [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), "png", "image/png"],
  [Uint8Array.of(255, 216, 255), "jpg", "image/jpeg"],
] as const)(
  "stages the native image with its encoded format",
  async (bytes, suffix, type) => {
    native.mockResolvedValue(bytes.buffer);
    const file = await readUnexposedClipboardImage(paste());
    expect(native).toHaveBeenCalledExactlyOnceWith(
      "clipboard_read_pasted_image",
    );
    expect(file).toMatchObject({ name: `Pasted image.${suffix}`, type });
    if (!file) throw new Error("Expected an image attachment");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  },
);

it("returns no attachment when the native pasteboard has no candidate image", async () => {
  native.mockResolvedValue(new ArrayBuffer(0));
  await expect(readUnexposedClipboardImage(paste())).resolves.toBeUndefined();
});

it("leaves regular file, rich text, ordinary text, and synthetic paste alone", () => {
  expect(readUnexposedClipboardImage(paste(["text/plain"]))).toBeUndefined();
  expect(
    readUnexposedClipboardImage(paste(["Files", "text/html"])),
  ).toBeUndefined();
  expect(
    readUnexposedClipboardImage(
      paste(["Files"], [{ kind: "file", type: "image/png" }]),
    ),
  ).toBeUndefined();
  expect(
    readUnexposedClipboardImage(
      paste(["Files"], [], [new File([], "example.png")]),
    ),
  ).toBeUndefined();
  expect(
    readUnexposedClipboardImage(paste(["Files"], [], [], false)),
  ).toBeUndefined();
  expect(native).not.toHaveBeenCalled();
});

it("leaves browser and non-macOS desktop paste alone", () => {
  desktop.mockReturnValue(false);
  expect(readUnexposedClipboardImage(paste())).toBeUndefined();
  desktop.mockReturnValue(true);
  vi.stubGlobal("navigator", { platform: "Win32" });
  expect(readUnexposedClipboardImage(paste())).toBeUndefined();
  expect(native).not.toHaveBeenCalled();
});
