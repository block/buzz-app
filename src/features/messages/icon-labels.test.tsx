// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MediaAttachment } from "./MediaAttachment";
import { ImageReviewStage } from "./ImageReviewStage";

class TestClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

const proxyImageSource =
  "/api/relay/media?url=https%3A%2F%2Fexample.test%2Fa.png";

function renderProxyImageStage() {
  const url = "https://example.test/a.png";
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => proxyImageSource}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
}

function stubImageCopySupport(write = vi.fn(async () => {})) {
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  vi.stubGlobal("navigator", { clipboard: { write } });
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    const element = createElement(tagName);
    if (tagName === "canvas") {
      vi.spyOn(element as HTMLCanvasElement, "getContext").mockReturnValue({
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(element as HTMLCanvasElement, "toBlob").mockImplementation(
        (callback) => callback(new Blob(["png"], { type: "image/png" })),
      );
    }
    return element;
  });
  return write;
}

function markPreviewLoaded() {
  const image = screen.getByAltText("Attachment preview");
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 12 },
    naturalHeight: { configurable: true, value: 8 },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("keeps playback controls named for their actions, not icon components", () => {
  const { container } = render(
    <MediaAttachment
      attachment={{ url: "https://example.test/a.mp4", kind: "video" }}
      media={(url) => url}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing player");
  fireEvent.play(video);
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
});
it("keeps proxy images as downloads", () => {
  renderProxyImageStage();
  const link = screen.getByRole("link", { name: "Download image" });
  expect(link).toHaveAttribute("href", proxyImageSource);
  expect(link).toHaveAttribute("download", "");
  expect(
    screen.queryByRole("link", { name: "Open image in browser" }),
  ).toBeNull();
});

it("shows a disabled copy button for proxy images when image clipboard is unsupported", async () => {
  const user = userEvent.setup();
  renderProxyImageStage();
  const button = screen.getByRole("button", { name: "Copy image" });
  expect(button).toBeDisabled();
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Image copy unavailable",
  );
});

it("copies proxy images and shows a stage-scoped success notice", async () => {
  vi.useFakeTimers();
  const write = stubImageCopySupport();
  renderProxyImageStage();
  markPreviewLoaded();

  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  await act(async () => {});

  expect(write).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("Image copied");
  await act(() => vi.advanceTimersByTimeAsync(3999));
  expect(screen.getByRole("status")).toHaveTextContent("Image copied");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("status")).toBeNull();
});

it("calls clipboard.write synchronously within the copy image click", () => {
  const write = stubImageCopySupport();
  renderProxyImageStage();
  markPreviewLoaded();

  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));

  // WebKit requires clipboard.write inside the user gesture; jsdom and Chromium
  // do not catch violations, so this assertion must stay before any await/flush.
  expect(write).toHaveBeenCalledTimes(1);
});

it("prevents duplicate image copy writes until the first settles", async () => {
  let finish!: () => void;
  const write = stubImageCopySupport(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  renderProxyImageStage();
  markPreviewLoaded();
  const button = screen.getByRole("button", { name: "Copy image" });

  fireEvent.click(button);
  try {
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    finish();
  }
  expect(await screen.findByRole("status")).toHaveTextContent("Image copied");
  expect(button).not.toBeDisabled();
});

it("reports image copy failures in a stage-scoped alert", async () => {
  vi.useFakeTimers();
  stubImageCopySupport(vi.fn(async () => Promise.reject(new Error("denied"))));
  renderProxyImageStage();
  markPreviewLoaded();

  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  await act(async () => {});

  const notice = screen.getByRole("alert");
  expect(notice).toHaveTextContent("Couldn't copy image");
  expect(notice.className).toContain("imageReviewCopyNoticeError");
  await act(() => vi.advanceTimersByTimeAsync(5999));
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't copy image");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears the image copy notice on a new copy attempt and image switch", async () => {
  vi.useFakeTimers();
  const write = stubImageCopySupport(vi.fn(async () => {}));
  const select = vi.fn();
  const first = "https://example.test/a.png";
  const second = "https://example.test/b.png";
  const { rerender } = render(
    <ImageReviewStage
      attachments={[
        { url: first, kind: "image" },
        { url: second, kind: "image" },
      ]}
      selectedUrl={first}
      media={() => proxyImageSource}
      select={select}
      onOpenLink={() => false}
    />,
  );
  markPreviewLoaded();

  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("Image copied");

  let finishSecond!: () => void;
  write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSecond = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {
    finishSecond();
  });
  expect(screen.getByRole("status")).toHaveTextContent("Image copied");

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(select).toHaveBeenCalledWith(second);
  rerender(
    <ImageReviewStage
      attachments={[
        { url: first, kind: "image" },
        { url: second, kind: "image" },
      ]}
      selectedUrl={second}
      media={() => proxyImageSource}
      select={select}
      onOpenLink={() => false}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not show a resolved copy notice after switching selected images", async () => {
  let finish!: () => void;
  const write = stubImageCopySupport(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const first = "https://example.test/a.png";
  const second = "https://example.test/b.png";
  const { rerender } = render(
    <ImageReviewStage
      attachments={[
        { url: first, kind: "image" },
        { url: second, kind: "image" },
      ]}
      selectedUrl={first}
      media={() => proxyImageSource}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  markPreviewLoaded();

  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  expect(write).toHaveBeenCalledTimes(1);
  rerender(
    <ImageReviewStage
      attachments={[
        { url: first, kind: "image" },
        { url: second, kind: "image" },
      ]}
      selectedUrl={second}
      media={() => proxyImageSource}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );

  try {
    await act(async () => {
      finish();
    });
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    finish();
  }
});

it("opens external images through the host opener without download semantics", () => {
  const url = "https://example.test/a.png";
  const open = vi.fn(() => true);
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
      onOpenLink={open}
    />,
  );
  const link = screen.getByRole("link", { name: "Open image in browser" });
  expect(link).toHaveAttribute("href", url);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(link).not.toHaveAttribute("download");
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledWith(url);
});

it("keeps external image fallback navigation when the host does not handle it", () => {
  const url = "https://example.test/unhandled.png";
  const open = vi.fn(() => false);
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
      onOpenLink={open}
    />,
  );
  expect(
    fireEvent.click(
      screen.getByRole("link", { name: "Open image in browser" }),
    ),
  ).toBe(true);
  expect(open).toHaveBeenCalledWith(url);
});

it("lets modified external image clicks use native browser behavior", () => {
  const url = "https://example.test/a.png";
  const open = vi.fn(() => true);
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
      onOpenLink={open}
    />,
  );
  fireEvent.click(screen.getByRole("link", { name: "Open image in browser" }), {
    metaKey: true,
  });
  expect(open).not.toHaveBeenCalled();
});

it("omits the image action for unsafe or missing sources", () => {
  const url = "https://example.test/a.png";
  const { rerender } = render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => "blob:https://example.test/a.png"}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
  rerender(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => undefined}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
});

it("does not render stray file attachments as images", () => {
  const { container } = render(
    <MediaAttachment
      attachment={{ url: "https://example.test/file.bin", kind: "file" }}
      media={(url) => url}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Attachment unavailable",
  );
  expect(container.querySelector("img")).toBeNull();
});
