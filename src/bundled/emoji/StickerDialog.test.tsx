// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { invoke } from "@tauri-apps/api/core";
import { StickerDialog, stickerSource } from "./StickerDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const lift = vi.mocked(invoke);

const relayUrl = `https://relay.test/media/${"a".repeat(64)}.jpg`;
const nativeUrl = `buzz-media://localhost/${encodeURIComponent(relayUrl)}`;
// A valid 1×1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

const message = {
  id: "m",
  channelId: "c",
  authorId: "a",
  content: "",
  attachments: [
    { url: relayUrl, kind: "image", mime: "image/jpeg", name: "Cat Nap.jpg" },
  ],
} as unknown as ChannelMessage;

function session(media: (url: string) => string | undefined = () => nativeUrl) {
  const add = vi.fn(async (name: string) => name);
  const upload = vi.fn(async (file: File) => ({
    url: "https://relay.test/media/sticker.png",
    type: file.type,
  }));
  const snapshot = { status: "ready", entries: [], mine: [] };
  return {
    add,
    upload,
    value: {
      media,
      emoji: {
        subscribe: () => () => {},
        snapshot: () => snapshot,
        ensure: async () => {},
        add,
        upload,
      },
    } as unknown as RelaySession,
  };
}

function open(value: RelaySession, close = vi.fn()) {
  render(
    <ToastProvider>
      <StickerDialog message={message} session={value} close={close} />
    </ToastProvider>,
  );
  return close;
}

const revoke = vi.fn();
beforeEach(() => {
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = revoke;
});
afterEach(() => {
  cleanup();
  lift.mockReset();
  revoke.mockReset();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

it("offers stickers only for raster image attachments", () => {
  expect(stickerSource(message)?.url).toBe(relayUrl);
  expect(
    stickerSource({
      ...message,
      attachments: [{ url: relayUrl, kind: "image", mime: "image/svg+xml" }],
    } as unknown as ChannelMessage),
  ).toBeUndefined();
  expect(
    stickerSource({
      ...message,
      attachments: [{ url: relayUrl, kind: "file" }],
    } as unknown as ChannelMessage),
  ).toBeUndefined();
});

it("uploads the lifted subject and saves it as the named emoji", async () => {
  lift.mockResolvedValue(PNG.buffer);
  const { add, upload, value } = session();
  open(value);
  expect(screen.getByRole("status")).toHaveTextContent("Lifting the subject");
  const save = screen.getByRole("button", { name: "Save sticker" });
  expect(save).toBeDisabled();
  expect(await screen.findByAltText("Sticker preview")).toBeVisible();
  expect(lift).toHaveBeenCalledExactlyOnceWith("media_lift_subject", {
    source: nativeUrl,
  });
  expect(screen.getByRole("textbox")).toHaveValue("cat_nap");
  await userEvent.setup().click(save);
  await waitFor(() => expect(add).toHaveBeenCalled());
  const file = upload.mock.calls[0]?.[0];
  expect(file?.type).toBe("image/png");
  expect(add).toHaveBeenCalledExactlyOnceWith(
    "cat_nap",
    "https://relay.test/media/sticker.png",
  );
  expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(PNG);
  expect(await screen.findByText("Added :cat_nap:")).toBeVisible();
  cleanup();
  expect(revoke).toHaveBeenCalledWith("blob:x");
});

it("does not publish the emoji when the dialog closes during upload", async () => {
  lift.mockResolvedValue(PNG.buffer);
  const { add, upload, value } = session();
  let release = () => {};
  upload.mockImplementationOnce(
    (file: File) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            url: "https://relay.test/media/sticker.png",
            type: file.type,
          });
      }),
  );
  const { unmount } = render(
    <ToastProvider>
      <StickerDialog message={message} session={value} close={() => {}} />
    </ToastProvider>,
  );
  await screen.findByAltText("Sticker preview");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save sticker" }));
  await waitFor(() => expect(upload).toHaveBeenCalled());
  unmount();
  release();
  // The save continues on microtasks only; a macrotask lets it finish.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(add).not.toHaveBeenCalled();
});

it("defaults animated GIFs to the whole image", async () => {
  lift.mockResolvedValue(PNG.buffer);
  const { value } = session();
  render(
    <ToastProvider>
      <StickerDialog
        message={
          {
            ...message,
            attachments: [{ url: relayUrl, kind: "image", mime: "image/gif" }],
          } as unknown as ChannelMessage
        }
        session={value}
        close={() => {}}
      />
    </ToastProvider>,
  );
  expect(
    await screen.findByRole("checkbox", { name: "Remove background" }),
  ).not.toBeChecked();
  expect(screen.getByAltText("Image preview")).toBeVisible();
});

it("saves the whole image without reuploading when background removal is off", async () => {
  lift.mockResolvedValue(PNG.buffer);
  const { add, upload, value } = session();
  open(value);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("checkbox", { name: "Remove background" }),
  );
  expect(screen.getByAltText("Image preview")).toHaveAttribute(
    "src",
    nativeUrl,
  );
  await user.click(screen.getByRole("button", { name: "Save sticker" }));
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith("cat_nap", relayUrl),
  );
  expect(upload).not.toHaveBeenCalled();
});

it("explains a failed lift and still saves the whole image", async () => {
  lift.mockRejectedValue("No subject found in this image");
  const { add, value } = session();
  open(value);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "No subject found in this image. You can still use the whole image.",
  );
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "nap{Enter}");
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith("nap", relayUrl),
  );
});

it("keeps the whole image where the host cannot lift subjects", async () => {
  const { add, value } = session(() => "/api/relay/media");
  open(value);
  expect(lift).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save sticker" }));
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith("cat_nap", relayUrl),
  );
});

it("shows a save failure and keeps the dialog open", async () => {
  lift.mockRejectedValue("No subject found in this image");
  const { add, value } = session();
  add.mockRejectedValueOnce(new Error("Relay rejected the emoji set."));
  const close = open(value);
  await screen.findByRole("status");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save sticker" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay rejected the emoji set.",
  );
  expect(close).not.toHaveBeenCalled();
});
