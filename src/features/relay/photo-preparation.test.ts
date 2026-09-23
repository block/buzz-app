import { afterEach, expect, it, vi } from "vitest";
import { UPLOAD_MAX_BYTES } from "./attachments";
import { preparePhoto, withPhotoPreparation } from "./photo-preparation";

const signal = () => new AbortController().signal;
const png = (width = 1, height = 1, animated = false) => {
  const bytes = new Uint8Array(animated ? 65 : 45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  if (animated) {
    view.setUint32(33, 8);
    bytes.set(new TextEncoder().encode("acTL"), 37);
  }
  bytes.set(new TextEncoder().encode("IEND"), bytes.length - 8);
  return new File([bytes], "photo.png", { type: "text/plain" });
};
afterEach(() => vi.unstubAllGlobals());

it("leaves generic files byte-for-byte unchanged", async () => {
  const file = new File(["document"], "report.pdf", { type: "image/png" });
  const read = vi
    .spyOn(file, "arrayBuffer")
    .mockRejectedValue(new Error("full read forbidden"));
  expect(await preparePhoto(file, signal())).toBe(file);
  expect(read).not.toHaveBeenCalled();
});

it.each([0, UPLOAD_MAX_BYTES + 1])(
  "rejects size %s before reading",
  async (size) => {
    const file = new File([new Uint8Array(size)], "file");
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(preparePhoto(file, signal())).rejects.toMatchObject({
      code: "size",
    });
    expect(read).not.toHaveBeenCalled();
  },
);

it.each([
  [0, 1],
  [1, 0],
  [5001, 5000],
])("rejects unsafe dimensions %j before decoding", async (width, height) => {
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  await expect(preparePhoto(png(width, height), signal())).rejects.toThrow(
    /prepared safely/,
  );
  expect(decode).not.toHaveBeenCalled();
});

it("does not flatten animated images or claim to prepare HEIC/GIF", async () => {
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  for (const file of [
    png(1, 1, true),
    new File(["GIF89a"], "animation.gif"),
    new File(["\0\0\0\x18ftypheic"], "phone.heic"),
  ]) {
    expect(await preparePhoto(file, signal())).toBe(file);
  }
  expect(decode).not.toHaveBeenCalled();
});

it("does not upload a static image when decoding fails", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockRejectedValue(new Error("broken codec")),
  );
  const upload = vi.fn();
  await expect(withPhotoPreparation(upload)(png(), signal())).rejects.toThrow(
    /prepared safely/,
  );
  expect(upload).not.toHaveBeenCalled();
});

it("rejects truncated photo containers before upload", async () => {
  const upload = vi.fn();
  for (const bytes of [
    [0xff, 0xd8, 0xff],
    [137, 80, 78, 71, 13, 10, 26, 10],
  ]) {
    await expect(
      withPhotoPreparation(upload)(
        new File([new Uint8Array(bytes)], "bad"),
        signal(),
      ),
    ).rejects.toThrow(/prepared safely/);
  }
  expect(upload).not.toHaveBeenCalled();
});

it("prevents cancelled reads from reaching decoding or upload", async () => {
  const controller = new AbortController();
  const file = png();
  const bytes = await file.arrayBuffer();
  vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
    controller.abort();
    return bytes;
  });
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  const upload = vi.fn();
  await expect(
    withPhotoPreparation(upload)(file, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(decode).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});

it("closes late decoded images without uploading after cancellation", async () => {
  const controller = new AbortController();
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", async () => {
    controller.abort();
    return { width: 1, height: 1, close };
  });
  const upload = vi.fn();
  await expect(
    withPhotoPreparation(upload)(png(), controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(close).toHaveBeenCalledOnce();
  expect(upload).not.toHaveBeenCalled();
});

it("passes the same cancellation authority to unchanged-file uploads", async () => {
  const file = new File(["text"], "file.txt");
  const active = signal();
  const result = {
    name: file.name,
    url: "https://relay.test/media/file",
    type: "text/plain",
    size: 4,
    sha256: "a".repeat(64),
  };
  const upload = vi.fn().mockResolvedValue(result);
  expect(await withPhotoPreparation(upload)(file, active)).toBe(result);
  expect(upload).toHaveBeenCalledWith(file, active);
});

it("discards late encoder output and releases resources before upload", async () => {
  const controller = new AbortController();
  const close = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: BlobCallback) => {
      controller.abort();
      callback(new Blob(["output"], { type: "image/png" }));
    },
  };
  vi.stubGlobal("createImageBitmap", async () => ({
    width: 1,
    height: 1,
    close,
  }));
  vi.stubGlobal("document", { createElement: () => canvas });
  const upload = vi.fn();
  await expect(
    withPhotoPreparation(upload)(png(), controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(upload).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect([canvas.width, canvas.height]).toEqual([0, 0]);
});
