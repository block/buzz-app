// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerAttachments } from "./ComposerAttachments";
import type { DraftAttachment } from "./attachment-draft";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

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

it("explains an upload failure on focus and preserves retry and removal", async () => {
  const retry = vi.fn();
  const remove = vi.fn();
  render(
    <ComposerAttachments
      items={[
        {
          id: "failed-file",
          file: new File(["document"], "report.pdf", {
            type: "application/pdf",
          }),
          status: "error",
          error: "The relay rejected this file.",
        },
      ]}
      disabled={false}
      retry={retry}
      remove={remove}
      media={() => undefined}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "The relay rejected this file.",
  );
  fireEvent.focus(
    screen.getByRole("button", { name: "Attachment issue: report.pdf" }),
  );
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "The relay rejected this file.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
  expect(retry).toHaveBeenCalledWith("failed-file");
  fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
  expect(remove).toHaveBeenCalledWith("failed-file");
});

it("keeps the uploading spinner actionable as a remove control", () => {
  const remove = vi.fn();
  render(
    <ComposerAttachments
      items={[
        {
          id: "pending",
          file: new File(["data"], "pending.pdf"),
          status: "uploading",
        },
      ]}
      disabled={false}
      remove={remove}
      retry={vi.fn()}
      media={() => undefined}
    />,
  );
  const control = screen.getByRole("button", { name: "Remove pending.pdf" });
  expect(control.hasAttribute("data-uploading")).toBe(true);
  fireEvent.click(control);
  expect(remove).toHaveBeenCalledWith("pending");
});

it("keeps one puff after the final attachment is removed and cleans up its timer", () => {
  vi.useFakeTimers();
  const play = vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn();
  const audioCreated = vi.fn();
  const imageCreated = vi.fn();
  vi.stubGlobal(
    "Image",
    class {
      constructor() {
        imageCreated();
      }
      src = "";
    },
  );
  vi.stubGlobal(
    "Audio",
    class {
      constructor() {
        audioCreated();
      }
      play = play;
      pause = pause;
      preload = "";
      volume = 1;
      currentTime = 0;
    },
  );
  const item: DraftAttachment = {
    id: "poof",
    file: new File(["data"], "remove.txt"),
    status: "ready",
  };
  const remove = vi.fn();
  const props = {
    disabled: false,
    remove,
    retry: vi.fn(),
    media: () => undefined,
  };
  const view = render(<ComposerAttachments {...props} items={[]} />);
  try {
    expect(audioCreated).not.toHaveBeenCalled();
    expect(imageCreated).not.toHaveBeenCalled();
    view.rerender(<ComposerAttachments {...props} items={[item]} />);
    expect(audioCreated).toHaveBeenCalledTimes(1);
    expect(imageCreated).toHaveBeenCalledTimes(5);
    const button = screen.getByRole("button", { name: "Remove remove.txt" });
    fireEvent.pointerDown(button);
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    view.rerender(<ComposerAttachments {...props} items={[]} />);
    expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
    expect(pause).not.toHaveBeenCalled();
    expect(
      document.querySelectorAll("[data-attachment-poof] img"),
    ).toHaveLength(5);
    act(() => vi.advanceTimersByTime(430));
    expect(document.querySelector("[data-attachment-poof]")).toBeNull();
    view.rerender(<ComposerAttachments {...props} items={[item]} />);
    expect(audioCreated).toHaveBeenCalledTimes(1);
    expect(imageCreated).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByRole("button", { name: "Remove remove.txt" }));
    expect(document.querySelector("[data-attachment-poof]")).not.toBeNull();
    view.unmount();
    expect(document.querySelector("[data-attachment-poof]")).toBeNull();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
