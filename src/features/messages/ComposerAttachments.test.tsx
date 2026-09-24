// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { assert, afterEach, expect, it, vi } from "vitest";
import { ComposerAttachments } from "./ComposerAttachments";
import type { DraftAttachment } from "./attachment-draft";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("replaces a failed original-video preview with authenticated converted media", async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:original"),
      revokeObjectURL: revoke,
    }),
  );
  const item: DraftAttachment = {
    id: "one",
    file: new File(["unsupported"], "clip.mov", { type: "video/quicktime" }),
    status: "uploading",
  };
  const props = {
    items: [item],
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: (url: string) => `/api/media?url=${encodeURIComponent(url)}`,
  };
  const root = render(<ComposerAttachments {...props} />);
  const original = root.container.querySelector("video");
  assert.exists(original);
  fireEvent.error(original);
  expect(screen.getByText("Preview unavailable")).toBeTruthy();
  const uploaded = {
    name: "clip.mp4",
    type: "video/mp4",
    size: 20,
    sha256: "a".repeat(64),
    url: "https://relay.test/media/clip.mp4",
  };
  await act(async () =>
    root.rerender(
      <ComposerAttachments
        {...props}
        items={[{ ...item, status: "ready", uploaded }]}
      />,
    ),
  );
  expect(screen.queryByText("Preview unavailable")).toBeNull();
  const converted = root.container.querySelector("video");
  assert.exists(converted);
  expect(converted.getAttribute("src")).toBe(props.media(uploaded.url));
  expect(converted).not.toBe(original);
  expect(revoke).toHaveBeenCalledWith("blob:original");
  fireEvent.click(screen.getByRole("button", { name: "Preview clip.mov" }));
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe(props.media(uploaded.url));
});

it.each(["report.pdf", "not-an-image.png", "not-a-video.mp4"])(
  "keeps uploaded generic %s inert instead of rendering media",
  (name) => {
    const create = vi.fn(() => "blob:original");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
    );
    const item: DraftAttachment = {
      id: "document",
      file: new File(["document"], name, { type: "video/mp4" }),
      status: "ready",
      uploaded: {
        name,
        type: "application/octet-stream",
        size: 8,
        sha256: "b".repeat(64),
        url: "https://relay.test/media/document.bin",
      },
    };
    const root = render(
      <ComposerAttachments
        items={[item]}
        disabled={false}
        remove={vi.fn()}
        retry={vi.fn()}
        media={() => "/api/relay/media?url=document"}
      />,
    );
    expect(screen.getByText(name)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: `Preview ${name}` }),
    ).toBeNull();
    expect(root.container.querySelector("video, img")).toBeNull();
    expect(screen.queryByText("Preview unavailable")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  },
);

it("does not fall back to an untrusted original when canonical media cannot be resolved", () => {
  const create = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
  );
  const item: DraftAttachment = {
    id: "one",
    file: new File(["source"], "clip.mov", { type: "video/quicktime" }),
    status: "ready",
    uploaded: {
      name: "clip.mp4",
      type: "video/mp4",
      size: 20,
      sha256: "a".repeat(64),
      url: "https://relay.test/media/clip.mp4",
    },
  };
  const root = render(
    <ComposerAttachments
      items={[item]}
      disabled={false}
      remove={vi.fn()}
      retry={vi.fn()}
      media={() => undefined}
    />,
  );
  expect(root.container.querySelector("video, img")).toBeNull();
  expect(create).not.toHaveBeenCalled();
});
