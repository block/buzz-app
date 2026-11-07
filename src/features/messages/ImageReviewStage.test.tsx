// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Profiler, StrictMode, useState } from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => {}),
}));
import type { Attachment } from "../relay/contracts";
import * as imageCopy from "./image-copy";
import * as nativeImageCopy from "./native-image-copy";
import { ImageReviewStage } from "./ImageReviewStage";

// jsdom does not implement pointer capture.
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};
// jsdom never loads images. Originals start decoded, as when the message grid
// already showed them; loadingImages() opts out.
function cachedImages() {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1,
  );
}
beforeEach(cachedImages);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  Reflect.deleteProperty(navigator, "connection");
});
function setup(width = 1000, height = 800) {
  render(
    <ImageReviewStage
      attachments={[{ url: "https://fixture.test/photo.png", kind: "image" }]}
      selectedUrl="https://fixture.test/photo.png"
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const image = screen.getByRole("img") as HTMLImageElement;
  const stage = image.parentElement;
  if (!stage) throw new Error("Missing stage");
  Object.defineProperties(image, {
    naturalWidth: { value: width },
    naturalHeight: { value: height },
  });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 400),
  );
  return { stage, image };
}
// Presses and releases the primary pointer, optionally dragging between them.
function press(target: HTMLElement, from: { x: number; y: number }, to = from) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: from.x,
    clientY: from.y,
  });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to.x, clientY: to.y });
}
const percent = () =>
  screen.getByRole("button", { name: /^Image zoom:/ }).textContent;
function gesture(stage: HTMLElement, type: string, scale: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, clientX: 250, clientY: 200 });
  fireEvent(stage, event);
  return event;
}
it.each(["{Enter}", " "])(
  "cycles image zoom presets with %s while keeping focus on the indicator",
  async (key) => {
    const user = userEvent.setup();
    const { image, stage } = setup();
    const cycle = screen.getByRole("button", { name: /^Image zoom:/ });
    expect(cycle).toHaveTextContent("100%");
    cycle.focus();
    for (const percent of [150, 200, 50, 100, 150]) {
      await user.keyboard(key);
      expect(cycle).toHaveTextContent(`${percent}%`);
      expect(cycle).toHaveFocus();
      expect(image.style.transform).toBe(
        percent === 100
          ? "none"
          : `translate(0px, 0px) scale(${percent / 100})`,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(cycle).toHaveTextContent("125%");
    fireEvent.click(cycle);
    expect(cycle).toHaveTextContent("150%");
    fireEvent.wheel(stage, { ctrlKey: true, deltaY: -10000 });
    expect(cycle).toHaveTextContent("400%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    fireEvent.click(cycle);
    expect(cycle).toHaveTextContent("50%");
  },
);

it("zooms out to a centered 50% minimum with buttons and pinch gestures", () => {
  const { stage, image } = setup();
  const minus = screen.getByRole("button", { name: "Zoom out" });
  const cycle = screen.getByRole("button", { name: /^Image zoom:/ });
  expect(minus).toBeEnabled();
  fireEvent.click(minus);
  expect(cycle).toHaveTextContent("75%");
  fireEvent.click(minus);
  expect(cycle).toHaveTextContent("50%");
  expect(minus).toBeDisabled();
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: 10000 });
  fireEvent.wheel(stage, { deltaX: 100, deltaY: 100 });
  expect(cycle).toHaveTextContent("50%");
  expect(image.style.transform).toBe("translate(0px, 0px) scale(0.5)");
  expect(stage).toHaveAttribute("data-review-zoomed");
  fireEvent.click(cycle);
  expect(cycle).toHaveTextContent("100%");
  expect(stage).not.toHaveAttribute("data-review-zoomed");
  gesture(stage, "gesturestart", 1);
  gesture(stage, "gesturechange", 0.1);
  gesture(stage, "gestureend", 0.1);
  expect(cycle).toHaveTextContent("50%");
});

it("pinches around the cursor and pans with two-finger scroll within image bounds", () => {
  const { stage, image } = setup();
  expect(
    fireEvent.wheel(stage, {
      ctrlKey: true,
      deltaY: -Math.log(2) / 0.01,
      clientX: 300,
      clientY: 200,
    }),
  ).toBe(false);
  expect(
    screen.getByRole("button", { name: /^Image zoom:/ }),
  ).toHaveTextContent("200%");
  expect(image.style.transform).toContain("translate(-50px, 0px)");
  fireEvent.wheel(stage, { deltaX: 60, deltaY: 40 });
  expect(image.style.transform).toContain("translate(-110px, -40px)");
  fireEvent.wheel(stage, { deltaX: 10000, deltaY: 10000 });
  expect(image.style.transform).toContain("translate(-250px, -200px)");
  fireEvent.click(screen.getByRole("button", { name: /^Image zoom:/ }));
  expect(image.style.transform).toBe("translate(0px, 0px) scale(0.5)");
  fireEvent.click(screen.getByRole("button", { name: /^Image zoom:/ }));
  expect(image.style.transform).toBe("none");
});
it("handles WebKit cumulative pinch scale without also applying wheel zoom", () => {
  const { stage, image } = setup();
  expect(gesture(stage, "gesturestart", 1).defaultPrevented).toBe(true);
  gesture(stage, "gesturechange", 2);
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: -100 });
  expect(image.style.transform).toContain("scale(2)");
  gesture(stage, "gesturechange", 3);
  expect(image.style.transform).toContain("scale(3)");
  gesture(stage, "gesturechange", 8);
  expect(image.style.transform).toContain("scale(4)");
  gesture(stage, "gestureend", 8);
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: Math.log(2) / 0.01 });
  expect(image.style.transform).toContain("scale(2)");
});
it("reclamps the image after resizing and leaves toolbar wheel input alone", () => {
  const { stage, image } = setup();
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });
  for (let step = 0; step < 4; step++) fireEvent.click(zoomIn);
  fireEvent.wheel(stage, { deltaY: 1000 });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 300),
  );
  fireEvent(window, new Event("resize"));
  expect(image.style.transform).toContain("translate(0px, -150px)");
  expect(
    fireEvent.wheel(zoomIn, {
      deltaY: 100,
    }),
  ).toBe(true);
});
it("reveals idle controls on movement and clears its timer on unmount", () => {
  vi.useFakeTimers();
  const { stage } = setup();
  act(() => vi.advanceTimersByTime(2200));
  expect(stage).toHaveAttribute("data-controls-idle");
  fireEvent.pointerMove(stage);
  expect(stage).not.toHaveAttribute("data-controls-idle");
  fireEvent.pointerLeave(stage);
  expect(stage).toHaveAttribute("data-controls-idle");
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["Zoom in"])(
  "resets zoom after %s for another image without replacing the toolbar",
  (action) => {
    const attachments = [
      { url: "https://fixture.test/one.png", kind: "image" as const },
      { url: "https://fixture.test/two.png", kind: "image" as const },
    ];
    const props = {
      attachments,
      media: (url: string) => url,
      select: () => {},
      onOpenLink: () => false,
    };
    const { rerender } = render(
      <ImageReviewStage
        {...props}
        selectedUrl="https://fixture.test/one.png"
      />,
    );
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(screen.getByRole("button", { name: action }));
    zoomIn.focus();
    rerender(
      <ImageReviewStage
        {...props}
        selectedUrl="https://fixture.test/two.png"
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Image zoom:/ }),
    ).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBe(zoomIn);
    expect(zoomIn).toHaveFocus();
  },
);

it("loads the original animated image and releases the transform after resetting zoom", () => {
  const url = "https://fixture.test/animated.gif";
  render(
    <ImageReviewStage
      attachments={[
        { url, kind: "image", previewUrl: "https://fixture.test/still.png" },
      ]}
      selectedUrl={url}
      media={(source) => source}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const image = screen.getByRole("img");
  expect(image).toHaveAttribute("src", url);
  expect(image).toHaveStyle({ transform: "none" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(image.style.transform).toContain("scale(1.25)");
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(screen.getByRole("img")).toBe(image);
  expect(image).toHaveStyle({ transform: "none" });
});

it("does not re-render the viewer for unchanged resize measurements", () => {
  const onRender = vi.fn();
  render(
    <Profiler id="image" onRender={onRender}>
      <ImageReviewStage
        attachments={[
          { url: "https://fixture.test/animated.gif", kind: "image" },
        ]}
        selectedUrl="https://fixture.test/animated.gif"
        media={(url) => url}
        select={() => {}}
        onOpenLink={() => false}
      />
    </Profiler>,
  );
  const commits = onRender.mock.calls.length;
  fireEvent(window, new Event("resize"));
  fireEvent(window, new Event("resize"));
  expect(onRender).toHaveBeenCalledTimes(commits);
});

const photo = (name: string, metadata?: Partial<Attachment>): Attachment => ({
  url: `https://fixture.test/${name}.png`,
  kind: "image",
  ...metadata,
});
const thumbnail = ({ url }: Attachment) => url.replace(/\.png$/, ".thumb.jpg");

function gallery(
  photos = ["one", "two", "three"].map((name) => photo(name)),
  preview?: (attachment: Attachment) => string | undefined,
) {
  function Gallery() {
    const [selectedUrl, select] = useState(photos[0]?.url ?? "");
    return (
      <div role="dialog" aria-modal="true" aria-label="Image viewer">
        <button type="button">Close</button>
        <ImageReviewStage
          attachments={photos}
          selectedUrl={selectedUrl}
          select={select}
          media={(url) => url}
          {...(preview ? { preview } : {})}
          onOpenLink={() => false}
        />
        <input aria-label="Comment" />
        <div
          contentEditable
          suppressContentEditableWarning
          data-testid="rich-comment"
        />
      </div>
    );
  }
  // As main.tsx does: React replays mount effects and ref callbacks in development.
  return render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}

it("navigates the gallery with buttons and left/right keys, resetting zoom and stopping at the ends", () => {
  gallery();
  expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/two.png",
  );
  expect(screen.getByText("2 / 3")).toHaveAttribute("aria-live", "polite");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/three.png",
  );
  expect(
    screen.getByRole("button", { name: /^Image zoom:/ }),
  ).toHaveTextContent("100%");
  expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(screen.getByText("3 / 3")).toBeVisible();
  fireEvent.keyDown(close, { key: "ArrowLeft" });
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(screen.getByText("1 / 3")).toBeVisible();
});

it.each(["{Enter}", " "])(
  "keeps enabled gallery buttons focused for repeated %s activation and falls back at endpoints",
  async (key) => {
    const user = userEvent.setup();
    gallery();
    const next = screen.getByRole("button", { name: "Next image" });
    const previous = screen.getByRole("button", { name: "Previous image" });
    const stage = screen.getByRole("group", { name: "Image gallery" });
    next.focus();
    await user.keyboard(key);
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(next).toHaveFocus();
    await user.keyboard(key);
    expect(screen.getByText("3 / 3")).toBeVisible();
    expect(next).toBeDisabled();
    expect(stage).toHaveFocus();

    previous.focus();
    await user.keyboard(key);
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(previous).toHaveFocus();
    await user.keyboard(key);
    expect(screen.getByText("1 / 3")).toBeVisible();
    expect(previous).toBeDisabled();
    expect(stage).toHaveFocus();
  },
);

it("leaves arrow keys to the comment editor, modifiers, and other overlays", () => {
  gallery();
  for (const target of [
    screen.getByRole("textbox", { name: "Comment" }),
    screen.getByTestId("rich-comment"),
  ]) {
    expect(fireEvent.keyDown(target, { key: "ArrowRight" })).toBe(true);
  }
  const close = screen.getByRole("button", { name: "Close" });
  expect(fireEvent.keyDown(close, { key: "ArrowRight", metaKey: true })).toBe(
    true,
  );
  render(<button type="button">Other overlay</button>);
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Other overlay" }), {
      key: "ArrowRight",
    }),
  ).toBe(true);
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(screen.getByText("2 / 3")).toBeVisible();
});

// Originals stay loading, as on a slow connection, until a test settles them.
function loadingImages() {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
}
async function decode(image: HTMLElement, decoded = Promise.resolve()) {
  Object.defineProperty(image, "decode", { value: () => decoded });
  await act(async () => {
    fireEvent.load(image);
  });
}
function stubAnimate() {
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel: vi.fn(),
      onfinish: null as (() => void) | null,
    }),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  return animate;
}
const stage = () => screen.getByRole("group", { name: "Image gallery" });
const original = () => screen.getByRole("img", { name: "Attachment preview" });
const arriving = () =>
  stage().querySelector("[data-gallery-preview]:not([data-gallery-departing])");

it("slides to the next photo's thumbnail at once and crossfades to its original once decoded", async () => {
  loadingImages();
  const assigned = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  const animate = stubAnimate();
  const photos = ["one", "two", "three"].map((name) => photo(name));
  gallery(photos, thumbnail);
  // Every thumbnail is fetched when the gallery opens.
  expect(assigned.mock.calls.map(([value]) => value)).toEqual(
    expect.arrayContaining(photos.map(thumbnail)),
  );
  const first = original();
  await decode(first);
  expect(arriving()).toHaveAttribute("data-gallery-ready");

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  const second = original();
  const preview = arriving();
  expect(second).toHaveAttribute("src", "https://fixture.test/two.png");
  expect(second).toHaveAttribute("data-gallery-loading");
  expect(preview).toHaveAttribute("data-gallery-preview", "thumbnail");
  expect(preview).toHaveAttribute("src", "https://fixture.test/two.thumb.jpg");
  expect(preview).not.toHaveAttribute("data-gallery-ready");
  // The slide does not wait for the second original.
  expect(first).toHaveAttribute("data-gallery-departing");
  expect(animate.mock.contexts).toEqual([first, second, preview]);
  expect(animate.mock.calls[0]?.[0][1]).toMatchObject({
    translate: "-40px 0px",
    opacity: 0,
  });
  for (const call of animate.mock.calls.slice(1))
    expect(call[0][0]).toMatchObject({ translate: "40px 0px", opacity: 0 });
  act(() => animate.mock.results[1]?.value.onfinish?.());
  expect(first).not.toBeInTheDocument();

  // A loaded original shows under its thumbnail until it has decoded.
  const decoding = deferred<void>();
  await decode(second, decoding.promise);
  expect(second).not.toHaveAttribute("data-gallery-loading");
  expect(preview).not.toHaveAttribute("data-gallery-ready");
  await act(async () => decoding.resolve());
  expect(preview).toHaveAttribute("data-gallery-ready");

  fireEvent.keyDown(stage(), { key: "ArrowLeft" });
  expect(animate.mock.contexts[3]).toBe(second);
  expect(animate.mock.calls[3]?.[0][1]).toMatchObject({
    translate: "40px 0px",
  });
  expect(animate.mock.calls[4]?.[0][0]).toMatchObject({
    translate: "-40px 0px",
  });
  cleanup();
  expect(animate.mock.results[4]?.value.cancel).toHaveBeenCalled();
});

it("fades the preview of an original that decoded mid-slide once the slide ends", async () => {
  loadingImages();
  const animate = stubAnimate();
  gallery(undefined, thumbnail);
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  const preview = arriving();
  await decode(original());
  expect(preview).toHaveAttribute("data-gallery-ready");
  // The slide's own animation holds the preview's opacity until it ends.
  expect(
    animate.mock.contexts.filter((element) => element === preview),
  ).toHaveLength(1);
  act(() => animate.mock.results[1]?.value.onfinish?.());
  const fade = animate.mock.calls.at(-1);
  expect(animate.mock.contexts.at(-1)).toBe(preview);
  expect(fade?.[0]).toEqual([{ opacity: 1 }, { opacity: 0 }]);
});

it("shows each photo during rapid navigation, never holding an earlier one", () => {
  loadingImages();
  const animate = stubAnimate();
  const mounted = gallery(undefined, thumbnail);
  const first = original();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("3 / 3")).toBeVisible();
  expect(original()).toHaveAttribute("src", "https://fixture.test/three.png");
  expect(arriving()).toHaveAttribute(
    "src",
    "https://fixture.test/three.thumb.jpg",
  );
  // Photos that never loaded leave as their thumbnails.
  expect(first).not.toBeInTheDocument();
  expect(
    Array.from(
      stage().querySelectorAll("[data-gallery-departing]"),
      (element) => element.getAttribute("src"),
    ),
  ).toEqual(["https://fixture.test/two.thumb.jpg"]);
  mounted.unmount();
  expect(animate.mock.results.at(-1)?.value.cancel).toHaveBeenCalled();
});

it("treats a fresh element for a revisited photo as loading again", async () => {
  loadingImages();
  const animate = stubAnimate();
  // Too large to warm, so no preload holds it once it leaves.
  const photos = [
    photo("one", { dimensions: { width: 8000, height: 6000 } }),
    photo("two"),
    photo("three"),
  ];
  gallery(photos, thumbnail);
  const first = original();
  await decode(first);
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  act(() => animate.mock.results[1]?.value.onfinish?.());
  expect(first).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  const revisited = original();
  expect(revisited).toHaveAttribute("src", "https://fixture.test/one.png");
  expect(revisited).toHaveAttribute("data-gallery-loading");
  expect(arriving()).toHaveAttribute(
    "src",
    "https://fixture.test/one.thumb.jpg",
  );
  expect(arriving()).not.toHaveAttribute("data-gallery-ready");
  Object.defineProperties(revisited, {
    naturalWidth: { value: 100 },
    naturalHeight: { value: 100 },
  });
  vi.spyOn(stage(), "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 400),
  );
  press(revisited, { x: 250, y: 200 });
  expect(percent()).toBe("100%");
  await decode(revisited);
  expect(arriving()).toHaveAttribute("data-gallery-ready");
  press(revisited, { x: 250, y: 200 });
  expect(percent()).toBe("200%");
});

it("swaps straight to the next photo's thumbnail when reduced motion is requested", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  loadingImages();
  const animate = stubAnimate();
  gallery(undefined, thumbnail);
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(original()).toHaveAttribute("src", "https://fixture.test/two.png");
  expect(arriving()).toHaveAttribute(
    "src",
    "https://fixture.test/two.thumb.jpg",
  );
  expect(document.querySelector("[data-gallery-departing]")).toBeNull();
  expect(animate).not.toHaveBeenCalled();
});

it("finishes a slide on resize without revealing a loading original", () => {
  loadingImages();
  stubAnimate();
  gallery(undefined, thumbnail);
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(stage().querySelector("[data-gallery-departing]")).not.toBeNull();
  fireEvent(window, new Event("resize"));
  expect(stage().querySelector("[data-gallery-departing]")).toBeNull();
  expect(original()).toHaveAttribute("data-gallery-loading");
  expect(arriving()).not.toHaveAttribute("data-gallery-ready");
});

it("frames a photo in its own aspect ratio without a thumbnail or after one fails", () => {
  loadingImages();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const assigned = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  gallery(
    [
      photo("one", {
        dimensions: { width: 2400, height: 1600 },
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      }),
      photo("two", { dimensions: { width: 1600, height: 2400 } }),
      photo("three"),
    ],
    (attachment) =>
      attachment.url.endsWith("two.png") ? undefined : thumbnail(attachment),
  );
  expect(arriving()).toHaveAttribute("data-gallery-preview", "thumbnail");
  fireEvent.error(arriving() as Element);
  expect(arriving()).toHaveAttribute("data-gallery-preview", "blurhash");
  expect(arriving()).toHaveAttribute("width", "32");
  expect(arriving()).toHaveAttribute("height", "21");
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(arriving()).toHaveAttribute("data-gallery-preview", "fill");
  expect(arriving()).toHaveAttribute("width", "21");
  expect(arriving()).toHaveAttribute("height", "32");
  // A thumbnail that failed to prefetch is not requested again. StrictMode's
  // replay cancelled the first prefetch.
  const prefetch = assigned.mock.contexts[
    assigned.mock.calls
      .map(([value]) => value)
      .lastIndexOf("https://fixture.test/three.thumb.jpg")
  ] as HTMLImageElement;
  fireEvent.error(prefetch);
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(arriving()).toBeNull();
  expect(original()).toHaveAttribute("src", "https://fixture.test/three.png");
});

it("prefetches thumbnails at low priority and keeps them while the gallery changes", () => {
  // The selected photo's own preview stays mounted while its original loads.
  loadingImages();
  const assigned = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  const [one, two, three] = ["one", "two", "three"].map((name) => photo(name));
  const stageWith = (photos: Attachment[]) => (
    <StrictMode>
      <ImageReviewStage
        attachments={photos}
        selectedUrl="https://fixture.test/two.png"
        select={() => {}}
        media={(url) => url}
        preview={thumbnail}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  // Prefetches are the detached images given a thumbnail.
  const prefetches = (from = 0) =>
    assigned.mock.calls.slice(from).flatMap(([value], index) => {
      const image = assigned.mock.contexts[from + index] as HTMLImageElement;
      return value?.endsWith(".thumb.jpg") && !image.isConnected ? [image] : [];
    });
  const held = () =>
    prefetches()
      .filter((image) => image.getAttribute("src"))
      .map((image) => image.getAttribute("src"));
  const view = render(stageWith([one, two] as Attachment[]));
  expect(held()).toEqual(
    [one, two].map((item) => thumbnail(item as Attachment)),
  );
  for (const image of prefetches())
    if (image.getAttribute("src")) expect(image.fetchPriority).toBe("low");

  // A reply adds a photo to the thread's gallery.
  const before = assigned.mock.calls.length;
  view.rerender(stageWith([one, two, three] as Attachment[]));
  expect(prefetches(before).map((image) => image.getAttribute("src"))).toEqual([
    thumbnail(three as Attachment),
  ]);
  expect(held()).toEqual(
    [one, two, three].map((item) => thumbnail(item as Attachment)),
  );
  // An edit removes one.
  const removed = assigned.mock.calls.length;
  view.rerender(stageWith([two, three] as Attachment[]));
  expect(
    prefetches(removed).filter((image) => image.getAttribute("src")),
  ).toEqual([]);
  expect(held()).toEqual(
    [two, three].map((item) => thumbnail(item as Attachment)),
  );
});

it("prefetches no thumbnails under Save-Data but still shows the selected photo's", () => {
  loadingImages();
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: { saveData: true },
  });
  const assigned = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  gallery(undefined, thumbnail);
  // Prefetches are the detached images given a thumbnail.
  const prefetches = assigned.mock.calls.filter(
    ([value], index) =>
      value?.endsWith(".thumb.jpg") &&
      !(assigned.mock.contexts[index] as HTMLImageElement).isConnected,
  );
  expect(prefetches).toEqual([]);
  expect(arriving()).toHaveAttribute("src", thumbnail(photo("one")));
});

it("shows a thumbnail again once a later prefetch of it succeeds", () => {
  loadingImages();
  const assigned = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  const [one, two] = ["one", "two"].map((name) => photo(name)) as [
    Attachment,
    Attachment,
  ];
  const stageWith = (photos: Attachment[], selected: Attachment) => (
    <StrictMode>
      <ImageReviewStage
        attachments={photos}
        selectedUrl={selected.url}
        select={() => {}}
        media={(url) => url}
        preview={thumbnail}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const prefetch = () =>
    assigned.mock.contexts[
      assigned.mock.calls.map(([value]) => value).lastIndexOf(thumbnail(one))
    ] as HTMLImageElement;
  const view = render(stageWith([one, two], two));
  fireEvent.error(prefetch());
  // An edit removes the photo and a later one restores it.
  view.rerender(stageWith([two], two));
  view.rerender(stageWith([one, two], two));
  view.rerender(stageWith([one, two], one));
  expect(arriving()).toBeNull();
  fireEvent.load(prefetch());
  expect(arriving()).toHaveAttribute("src", thumbnail(one));
});

it("copies and click-zooms only a decoded original", async () => {
  loadingImages();
  const copy = stubImageCopy();
  copyGallery();
  const image = original();
  Object.defineProperties(image, {
    naturalWidth: { value: 100 },
    naturalHeight: { value: 100 },
  });
  vi.spyOn(stage(), "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 400),
  );
  const button = screen.getByRole("button", { name: "Copy image" });
  expect(button).toBeDisabled();
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("100%");

  await decode(image);
  expect(button).toBeEnabled();
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("200%");
  await act(async () => {
    fireEvent.click(button);
  });
  expect(copy).toHaveBeenCalledWith(image);

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("button", { name: "Copy image" })).toBeDisabled();
});

// Preload requests are the `src` assignments to images outside the stage.
function warming() {
  loadingImages();
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve(),
  });
  const assigned = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  const url = (name: string) => `https://fixture.test/${name}.png`;
  let replayed = new Set<HTMLImageElement>();
  const warmers = () =>
    assigned.mock.calls.flatMap(([value], index) => {
      const image = assigned.mock.contexts[index] as HTMLImageElement;
      return value &&
        !image.hasAttribute("data-review-media") &&
        !replayed.has(image)
        ? [{ value, image }]
        : [];
    });
  gallery(["one", "two", "three", "four", "five"].map((name) => photo(name)));
  // StrictMode replays the mount effects once, cancelling their first requests.
  replayed = new Set(
    warmers().flatMap(({ image }) => (image.getAttribute("src") ? [] : image)),
  );
  const warmer = (name: string) => {
    const found = warmers().find(({ value }) => value === url(name));
    if (!found) throw new Error(`${name} was not preloaded`);
    return found.image;
  };
  return {
    url,
    warmer,
    requested: () =>
      warmers().map(({ value }) => value.replace(/^.*\/(\w+)\.png$/, "$1")),
    settle: (...names: string[]) =>
      act(async () => {
        for (const name of names) fireEvent.load(warmer(name));
      }),
  };
}

it("warms the next two originals in the direction of travel and the previous one, two at a time", async () => {
  const { requested, warmer, settle } = warming();
  expect(original()).toHaveAttribute("fetchpriority", "high");
  expect(requested()).toEqual(["two", "three"]);
  expect(warmer("two").fetchPriority).toBe("low");
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  // One keeps loading as the previous photo, so four waits for a free slot.
  expect(requested()).toEqual(["two", "three"]);
  await settle("two", "three");
  expect(requested()).toEqual(["two", "three", "four"]);
});

it("cancels originals that leave the window, including a photo visited before it loaded", async () => {
  const { url, requested, warmer, settle } = warming();
  const first = original();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  await settle("two", "three");
  expect(first).toHaveAttribute("src", url("one"));
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(first).toHaveAttribute("src", "");
  expect(requested()).toEqual(["two", "three", "four", "five"]);
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  for (const name of ["four", "five"])
    expect(warmer(name)).toHaveAttribute("src", "");
  expect(requested().at(-1)).toBe("one");
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function copyGallery() {
  const photos = ["one", "two"].map((name) => ({
    url: `https://fixture.test/${name}.png`,
    kind: "image" as const,
  }));
  function CopyGallery() {
    const [selectedUrl, select] = useState(photos[0]?.url ?? "");
    return (
      <ImageReviewStage
        attachments={photos}
        selectedUrl={selectedUrl}
        select={select}
        media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
        onOpenLink={() => false}
      />
    );
  }
  return render(<CopyGallery />);
}

function stubImageCopy({ supported = true } = {}) {
  vi.spyOn(imageCopy, "supportsImageCopy").mockReturnValue(supported);
  const copy = vi.spyOn(imageCopy, "copyImageToClipboard").mockResolvedValue();
  return copy;
}

it("offers native copy independently of browser clipboard support", async () => {
  const broker = stubImageCopy({ supported: false });
  const native = vi
    .spyOn(nativeImageCopy, "copyNativeImage")
    .mockResolvedValue();
  const attachments = [
    { url: "proxy", kind: "image" as const },
    { url: "external", kind: "image" as const },
    { url: "native", kind: "image" as const },
  ];
  function SourcesGallery() {
    const [selectedUrl, select] = useState("proxy");
    return (
      <ImageReviewStage
        attachments={attachments}
        selectedUrl={selectedUrl}
        media={(url) =>
          ({
            proxy:
              "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fphoto.png",
            external: "https://cdn.fixture.test/photo.png",
            native:
              "buzz-media://localhost/https%3A%2F%2Ffixture.test%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          })[url]
        }
        select={select}
        onOpenLink={() => false}
      />
    );
  }
  render(<SourcesGallery />);
  expect(
    screen.queryByRole("button", { name: "Copy image" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(
    screen.queryByRole("button", { name: "Copy image" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  const button = screen.getByRole("button", { name: "Copy image" });
  fireEvent.click(button);
  expect(native).toHaveBeenCalledWith(
    "buzz-media://localhost/https%3A%2F%2Ffixture.test%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  expect(broker).not.toHaveBeenCalled();
  expect(await screen.findByText("Image copied")).toHaveAttribute(
    "role",
    "status",
  );

  native.mockRejectedValueOnce(new Error("clipboard denied"));
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't copy image",
  );
  expect(broker).not.toHaveBeenCalled();

  cleanup();
  vi.restoreAllMocks();
  cachedImages();
  const supportedBroker = stubImageCopy({ supported: true });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  expect(supportedBroker).toHaveBeenCalledTimes(1);
});

it("ignores duplicate copy presses while a clipboard write is pending", async () => {
  const gate = deferred<void>();
  const copy = stubImageCopy();
  copy.mockReturnValue(gate.promise);
  const user = userEvent.setup();
  setup();
  const button = screen.getByRole("button", { name: "Copy image" });

  try {
    await user.click(button);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(copy).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
  }
  expect(await screen.findByRole("status")).toHaveTextContent("Image copied");
});

it("shows copy success and failure messages and clears them on timers", async () => {
  vi.useFakeTimers();
  const copy = stubImageCopy();
  setup();
  const button = screen.getByRole("button", { name: "Copy image" });

  fireEvent.click(button);
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("Image copied");
  act(() => vi.advanceTimersByTime(3999));
  expect(screen.getByText("Image copied")).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("Image copied")).not.toBeInTheDocument();

  copy.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(button);
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't copy image");
  act(() => vi.advanceTimersByTime(5999));
  expect(screen.getByText("Couldn't copy image")).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("Couldn't copy image")).not.toBeInTheDocument();
});

it("clears copy feedback when switching gallery images", async () => {
  stubImageCopy();
  const user = userEvent.setup();
  copyGallery();
  await user.click(screen.getByRole("button", { name: "Copy image" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Image copied");

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.png",
  );
  expect(screen.queryByText("Image copied")).not.toBeInTheDocument();
});

it("does not show copy feedback when a stale copy finishes after switching images", async () => {
  const gate = deferred<void>();
  const copy = stubImageCopy();
  copy.mockReturnValue(gate.promise);
  const user = userEvent.setup();
  copyGallery();
  await user.click(screen.getByRole("button", { name: "Copy image" }));
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));

  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(screen.queryByText("Image copied")).not.toBeInTheDocument();
  expect(screen.queryByText("Couldn't copy image")).not.toBeInTheDocument();
});

it.each([
  ["a large landscape image to actual pixels", 4000, 3000, "800%"],
  ["a large portrait image to actual pixels", 3000, 4000, "1000%"],
  ["a small image to twice its fitted size", 100, 80, "200%"],
  ["a nearly fitted image to twice its fitted size", 600, 480, "200%"],
])("clicks %s and clicks back to fit", (_, width, height, zoomed) => {
  const { image } = setup(width, height);
  fireEvent.load(image);
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe(zoomed);
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("100%");
  expect(image.style.transform).toBe("none");
});

it("anchors click zoom at the pointer and returns to a centered fit", () => {
  const { image } = setup(4000, 3000);
  fireEvent.load(image);
  press(image, { x: 300, y: 250 });
  // Fit is 1/8, so the click point (50, 50) from center stays under the cursor.
  expect(image.style.transform).toBe("translate(-350px, -350px) scale(8)");
  press(image, { x: 10, y: 10 });
  expect(image.style.transform).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("100%");
});

it("pans across extreme aspect ratios after click zoom without toggling zoom", () => {
  const { image } = setup(10000, 100);
  fireEvent.load(image);
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("2000%");
  // Dragging pans to the far edge and leaves the zoom alone.
  press(image, { x: 250, y: 200 }, { x: -10000, y: 0 });
  expect(percent()).toBe("2000%");
  expect(image.style.transform).toBe("translate(-4750px, 0px) scale(20)");
  // Jitter inside the click slop still counts as a click.
  press(image, { x: 250, y: 200 }, { x: 253, y: 202 });
  expect(percent()).toBe("100%");
});

it("does not click-zoom from the toolbar or secondary buttons", () => {
  const { image } = setup(4000, 3000);
  fireEvent.load(image);
  fireEvent.pointerDown(image, { pointerId: 1, button: 2 });
  fireEvent.pointerUp(image, { pointerId: 1, button: 2 });
  press(screen.getByRole("button", { name: "Zoom in" }), { x: 250, y: 380 });
  expect(percent()).toBe("100%");
});

it("lets large images reach twice their actual pixels and reclamps on resize", () => {
  const { stage, image } = setup(4000, 3000);
  fireEvent.load(image);
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: -10000 });
  expect(percent()).toBe("1600%");
  expect(zoomIn).toBeDisabled();
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 800),
  );
  fireEvent(window, new Event("resize"));
  expect(percent()).toBe("800%");
  expect(zoomIn).toBeDisabled();
});

it("describes click zoom and resets it when the gallery changes image", () => {
  gallery();
  const image = screen.getByRole("img", { name: "Attachment preview" });
  expect(image).toHaveAccessibleDescription("Click the image to zoom.");
  Object.defineProperties(image, {
    naturalWidth: { value: 100 },
    naturalHeight: { value: 100 },
  });
  press(image, { x: 0, y: 0 });
  expect(percent()).toBe("200%");
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  expect(percent()).toBe("100%");
  expect(
    screen.getByRole("img", { name: "Attachment preview" }),
  ).toHaveAccessibleDescription("Click the image to zoom.");
});

it("does not zoom any gallery image with a press held across navigation", () => {
  gallery();
  const image = screen.getByRole("img", { name: "Attachment preview" });
  const stage = image.parentElement;
  if (!stage) throw new Error("Missing stage");
  fireEvent.pointerDown(image, { pointerId: 1, button: 0, isPrimary: true });
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.pointerUp(stage, { pointerId: 1 });
  expect(percent()).toBe("100%");
  // Returning to the original image does not revive the stale press.
  fireEvent.pointerDown(
    screen.getByRole("img", { name: "Attachment preview" }),
    {
      pointerId: 1,
      button: 0,
      isPrimary: true,
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.pointerUp(stage, { pointerId: 1 });
  expect(percent()).toBe("100%");
  press(screen.getByRole("img", { name: "Attachment preview" }), {
    x: 0,
    y: 0,
  });
  expect(percent()).toBe("200%");
});

it.each([
  ["second", [2, 1]],
  ["first", [1, 2]],
])(
  "treats overlapping contacts as a gesture when the %s contact lifts first",
  (_, order) => {
    const { stage, image } = setup();
    for (const pointerId of [1, 2])
      fireEvent.pointerDown(image, {
        pointerId,
        button: 0,
        isPrimary: pointerId === 1,
        clientX: 250,
      });
    for (const pointerId of order)
      fireEvent.pointerUp(stage, { pointerId, clientX: 250 });
    expect(percent()).toBe("100%");
    press(image, { x: 250, y: 200 });
    expect(percent()).toBe("200%");
  },
);

it("does not click-zoom a non-primary image contact without a stage-owned press", () => {
  const { stage, image } = setup();
  // The primary contact may be on the toolbar or outside this stage.
  fireEvent.pointerDown(image, {
    pointerId: 2,
    button: 0,
    isPrimary: false,
    clientX: 250,
    clientY: 200,
  });
  fireEvent.pointerUp(stage, { pointerId: 2, clientX: 250, clientY: 200 });
  expect(percent()).toBe("100%");
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("200%");
});

it.each(["pointerCancel", "lostPointerCapture"] as const)(
  "ends only the owning press on %s",
  (type) => {
    const { stage, image } = setup();
    fireEvent.pointerDown(image, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 250,
    });
    fireEvent[type](stage, { pointerId: 2 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 250 });
    expect(percent()).toBe("200%");
    fireEvent.pointerDown(image, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 250,
    });
    fireEvent[type](stage, { pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 250 });
    expect(percent()).toBe("200%");
  },
);

it("sends the selected image filename with its authenticated native download source", async () => {
  const url = `https://relay.example/media/${"a".repeat(64)}.png`;
  const source = `http://buzz-media.localhost/${encodeURIComponent(url)}`;
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image", name: "photo.png" }]}
      selectedUrl={url}
      media={() => source}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  expect(invoke).toHaveBeenCalledWith("media_download", {
    source,
    name: "photo.png",
  });
  // The live region is always mounted and already reads "Downloading…", so an
  // existence query resolves before the mocked download settles.
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Saved to Downloads"),
  );
});

function nativeDownloadGallery() {
  const photos = ["a", "b"].map((id) => ({
    url: `https://relay.test/media/${id.repeat(64)}.png`,
    name: `${id}.png`,
    kind: "image" as const,
  }));
  function Gallery() {
    const [selectedUrl, select] = useState(
      `https://relay.test/media/${"a".repeat(64)}.png`,
    );
    return (
      <ImageReviewStage
        attachments={photos}
        selectedUrl={selectedUrl}
        select={select}
        media={(url) => `buzz-media://localhost/${encodeURIComponent(url)}`}
        onOpenLink={() => false}
        allowCopy={false}
      />
    );
  }
  return render(<Gallery />);
}

it("keeps image download controls visible and focused while blocking pending repeats", async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  vi.mocked(invoke).mockClear().mockReturnValueOnce(gate.promise);
  nativeDownloadGallery();
  const button = screen.getByRole("button", { name: "Download image" });
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Downloading…");
  const stage = screen.getByRole("group", { name: "Image gallery" });
  act(() => vi.advanceTimersByTime(2200));
  expect(stage).toHaveAttribute("data-controls-revealed");
  expect(stage).not.toHaveAttribute("data-controls-idle");
  await act(async () => gate.resolve());
  expect(screen.getByRole("status")).toHaveTextContent("Saved to Downloads");
  act(() => vi.advanceTimersByTime(3999));
  expect(stage).toHaveAttribute("data-controls-revealed");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(stage).not.toHaveAttribute("data-controls-revealed");
});

it("keeps failed image downloads retryable and recovers on success", async () => {
  const gate = deferred<void>();
  vi.mocked(invoke)
    .mockClear()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockReturnValueOnce(gate.promise);
  nativeDownloadGallery();
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t download. Try again.",
  );
  expect(screen.getByRole("group", { name: "Image gallery" })).toHaveAttribute(
    "data-controls-revealed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry download image" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => gate.resolve());
  expect(screen.getByRole("status")).toHaveTextContent("Saved to Downloads");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["success", "failure"])(
  "retires an image download's old %s after navigating away and back",
  async (result) => {
    const gate = deferred<void>();
    vi.mocked(invoke).mockClear().mockReturnValueOnce(gate.promise);
    nativeDownloadGallery();
    fireEvent.click(screen.getByRole("button", { name: "Download image" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    await act(async () =>
      result === "success"
        ? gate.resolve()
        : gate.reject(new Error("old failure")),
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download image" }),
    ).not.toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("group", { name: "Image gallery" }),
    ).not.toHaveAttribute("data-controls-revealed");
  },
);

it("hides Copy when the host does not provide image clipboard access", () => {
  stubImageCopy();
  render(
    <ImageReviewStage
      attachments={[{ url: "https://fixture.test/photo.png", kind: "image" }]}
      selectedUrl="https://fixture.test/photo.png"
      media={(url) => url}
      select={() => {}}
      onOpenLink={() => false}
      allowCopy={false}
    />,
  );
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Copy image" }),
  ).not.toBeInTheDocument();
});
