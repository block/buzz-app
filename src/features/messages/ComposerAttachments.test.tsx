// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
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
it("shows progress during preparation and upload while the thumbnail stays clickable", () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:photo"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const item: DraftAttachment = {
    id: "photo",
    file: new File(["png"], "photo.png", { type: "image/png" }),
    status: "queued",
  };
  const props = {
    items: [item],
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: () => undefined,
  };
  const root = render(<ComposerAttachments {...props} />);
  const remove = screen.getByRole("button", { name: "Remove photo.png" });
  expect(
    screen
      .getByRole("button", { name: "Preview photo.png" })
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe("blob:photo");
  // A queued sibling waits its turn while keeping a clickable local preview.
  expect(screen.getByRole("progressbar")).toBeTruthy();
  expect(remove.querySelector("[data-upload-cancel]")).not.toBeNull();

  for (const status of ["preparing", "uploading"] as const) {
    root.rerender(
      <ComposerAttachments {...props} items={[{ ...item, status }]} />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Uploading photo.png",
    );
    expect(remove.querySelector("[data-upload-cancel]")).not.toBeNull();
  }
  for (const status of ["ready", "error"] as const) {
    root.rerender(
      <ComposerAttachments {...props} items={[{ ...item, status }]} />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: `${status === "error" ? "Retry" : "Remove"} photo.png`,
      }),
    ).toBeTruthy();
  }
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
  "uses canonical generic type for %s instead of rendering image or video",
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
      screen.getByRole("button", { name: `Preview ${name}` }),
    ).toBeTruthy();
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
  fireEvent.focus(screen.getByRole("button", { name: "Retry report.pdf" }));
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "The relay rejected this file. Press Delete to remove.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
  expect(retry).toHaveBeenCalledWith("failed-file");
  fireEvent.keyDown(screen.getByRole("button", { name: "Retry report.pdf" }), {
    key: "Delete",
  });
  expect(remove).toHaveBeenCalledWith("failed-file");
});

it("keeps removal available during upload", () => {
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
  expect(screen.getByRole("progressbar")).toBeTruthy();
  fireEvent.click(control);
  expect(remove).toHaveBeenCalledWith("pending");
});

it("removes immediately without playing a poof sound", () => {
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  const item: DraftAttachment = {
    id: "one",
    file: new File(["text"], "notes.txt"),
    status: "queued",
  };
  const remove = vi.fn();
  const props = {
    disabled: false,
    remove,
    retry: vi.fn(),
    media: () => undefined,
  };
  const view = render(<ComposerAttachments {...props} items={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  expect(remove).toHaveBeenCalledWith("one");
  view.rerender(<ComposerAttachments {...props} items={[]} />);
  expect(audio).not.toHaveBeenCalled();
  expect(document.querySelector("[data-attachment-poof]")).toBeNull();
});

it("dismisses draft preview while retaining the original file and preview URL", async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi
        .fn()
        .mockReturnValueOnce("blob:thumbnail")
        .mockReturnValue("blob:viewer"),
      revokeObjectURL: revoke,
    }),
  );
  const items: DraftAttachment[] = [
    {
      id: "draft",
      file: new File(["image"], "draft.png", { type: "image/png" }),
      status: "uploading",
    },
  ];
  const remove = vi.fn(),
    retry = vi.fn();
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <div hidden={!active} inert={!active}>
        <ComposerAttachments
          items={items}
          disabled={false}
          remove={remove}
          retry={retry}
          media={(url) => url}
        />
      </div>
    </ConversationPresentation>
  );
  const view = render(tree(true));
  const thumbnail = view.container.querySelector("img");
  const trigger = screen.getByRole("button", { name: "Preview draft.png" });
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    ),
  );
  const focus = vi.spyOn(trigger, "focus");
  view.rerender(tree(false));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  view.rerender(tree(true));
  await act(() => Promise.resolve());
  expect(focus).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(view.container.querySelector("img")).toBe(thumbnail);
  expect(revoke).toHaveBeenCalledWith("blob:viewer");
  expect(revoke).not.toHaveBeenCalledWith("blob:thumbnail");
  expect(remove).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
});

it("navigates local image and video previews while uploading without sent-message controls", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    }),
  );
  const items: DraftAttachment[] = [
    {
      id: "image",
      file: new File(["image"], "photo.png", { type: "image/png" }),
      status: "uploading",
      transfer: { sent: 2, total: 8 },
    },
    {
      id: "video",
      file: new File(["video"], "clip.mp4"),
      status: "preparing",
    },
  ];
  const remove = vi.fn(),
    retry = vi.fn();
  const props = {
    items,
    disabled: false,
    remove,
    retry,
    media: (url: string) => `/canonical?url=${url}`,
  };
  const view = render(<ComposerAttachments {...props} />);
  expect(
    screen
      .getByRole("progressbar", { name: "Uploading photo.png" })
      .getAttribute("aria-valuenow"),
  ).toBe("25");
  const trigger = screen.getByRole("button", { name: "Preview clip.mp4" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe("blob:clip.mp4");
  expect(screen.getByRole("button", { name: /Playback speed/ })).toBeTruthy();
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: " " });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /comments/i })).toBeNull();
  expect(screen.queryByLabelText("Media comments")).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(
    screen.getByRole("dialog").querySelector("img")?.getAttribute("src"),
  ).toBe("blob:photo.png");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  assert.exists(items[0]);
  assert.exists(items[1]);
  view.rerender(
    <ComposerAttachments
      {...props}
      items={[
        items[0],
        {
          ...items[1],
          status: "ready",
          uploaded: {
            url: "https://relay.test/clip.mp4",
            name: "clip.mp4",
            type: "video/mp4",
            size: 8,
            sha256: "a".repeat(64),
          },
        },
      ]}
    />,
  );
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe("/canonical?url=https://relay.test/clip.mp4");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Preview clip.mp4" }),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Preview photo.png" }),
  ).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
});
