// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnimatedAvatarCapture } from "./AnimatedAvatarCapture";
import * as capture from "./animated-avatar-capture";
import { uploadAvatar } from "./avatar-upload";

vi.mock("./animated-avatar-capture", () => ({
  ANIMATED_AVATAR_SIZE: 256,
  DEFAULT_PERSON_SCALE: 1.26,
  DEFAULT_PERSON_OFFSET_X: 1,
  DEFAULT_PERSON_OFFSET_Y: 7,
  DEFAULT_SHAPE_SCALE: 1.12,
  DEFAULT_SHAPE_OFFSET_X: 0,
  DEFAULT_SHAPE_OFFSET_Y: -7,
  openAvatarCamera: vi.fn(),
  stopAvatarCamera: vi.fn(),
  listAvatarCameras: vi.fn(async () => []),
  preloadAvatarSegmenter: vi.fn(),
  recordAnimatedAvatarFrames: vi.fn(),
  createAvatarFrameBitmaps: vi.fn(),
  composeAvatarFrame: vi.fn(),
  composeAvatarFrames: vi.fn(),
  encodeAvatarAnimation: vi.fn(),
  renderAvatarPosterPng: vi.fn(),
}));
vi.mock("./avatar-upload", () => ({ uploadAvatar: vi.fn() }));
vi.mock("motion/react", () => ({ useReducedMotion: () => true }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(
    640,
  );
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(
    480,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const stream = {
  getVideoTracks: () => [new EventTarget()],
} as unknown as MediaStream;
function mount() {
  const apply = vi.fn();
  return {
    apply,
    ...render(
      <AnimatedAvatarCapture
        community="https://relay.example"
        disabled={false}
        onApply={apply}
      />,
    ),
  };
}
it("stops a camera that arrives after the tab is closed", async () => {
  const pending = deferred<MediaStream>();
  vi.mocked(capture.openAvatarCamera).mockReturnValueOnce(pending.promise);
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  expect(screen.getByRole("status")).toHaveTextContent("Starting camera");
  view.unmount();
  await act(async () => pending.resolve(stream));
  expect(capture.stopAvatarCamera).toHaveBeenCalledWith(stream);
});
it("waits for preview playback and releases the camera if playback fails", async () => {
  vi.mocked(capture.openAvatarCamera).mockResolvedValueOnce(stream);
  const playback = deferred<void>();
  vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(
    playback.promise,
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  await waitFor(() =>
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled(),
  );
  expect(screen.queryByRole("button", { name: "Record 3 seconds" })).toBeNull();
  await act(async () => playback.resolve());
  expect(
    screen.getByRole("button", { name: "Record 3 seconds" }),
  ).toBeEnabled();
});
it("uploads the poster and animation before applying the mobile-compatible URL", async () => {
  vi.mocked(capture.openAvatarCamera).mockResolvedValueOnce(stream);
  vi.mocked(capture.recordAnimatedAvatarFrames).mockResolvedValueOnce({
    frames: [],
    backgroundRemoved: true,
  });
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  vi.mocked(capture.createAvatarFrameBitmaps).mockResolvedValueOnce([bitmap]);
  vi.mocked(capture.composeAvatarFrames).mockReturnValue([{} as ImageData]);
  vi.mocked(capture.renderAvatarPosterPng).mockResolvedValue(
    new Uint8Array([1]),
  );
  vi.mocked(capture.encodeAvatarAnimation).mockReturnValue(new Uint8Array([2]));
  const animationUpload = deferred<string>();
  vi.mocked(uploadAvatar)
    .mockResolvedValueOnce("https://relay.example/poster.png")
    .mockReturnValueOnce(animationUpload.promise);
  const { apply } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Record 3 seconds" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(2));
  expect(capture.stopAvatarCamera).toHaveBeenCalledWith(stream);
  expect(
    screen.getByRole("button", { name: "Saving", busy: true }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(apply).not.toHaveBeenCalled();
  await act(async () =>
    animationUpload.resolve("https://relay.example/animation.png"),
  );
  expect(apply).toHaveBeenCalledWith(
    "https://relay.example/poster.png#buzz-anim=https%3A%2F%2Frelay.example%2Fanimation.png",
  );
});
it("reports denied camera permission and allows retry", async () => {
  vi.mocked(capture.openAvatarCamera).mockRejectedValueOnce(
    new Error("Camera permission denied"),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Camera permission denied",
  );
  expect(screen.getByRole("button", { name: "Start camera" })).toHaveFocus();
});

it.each(["live", "recording"])(
  "recovers from a disconnected camera while %s",
  async (phase) => {
    const track = new EventTarget();
    const disconnected = {
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    vi.mocked(capture.openAvatarCamera)
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(stream);
    const take =
      deferred<
        Awaited<ReturnType<typeof capture.recordAnimatedAvatarFrames>>
      >();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
    const record = await screen.findByRole("button", {
      name: "Record 3 seconds",
    });
    if (phase === "recording") {
      vi.mocked(capture.recordAnimatedAvatarFrames).mockReturnValueOnce(
        take.promise,
      );
      fireEvent.click(record);
    }
    act(() => {
      track.dispatchEvent(new Event("ended"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Camera disconnected");
    expect(capture.stopAvatarCamera).toHaveBeenCalledWith(disconnected);
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
    await screen.findByRole("button", { name: "Record 3 seconds" });
    if (phase === "recording") {
      expect(
        vi.mocked(capture.recordAnimatedAvatarFrames).mock.calls[0]?.[1]?.signal
          ?.aborted,
      ).toBe(true);
      await act(async () =>
        take.resolve({ frames: [], backgroundRemoved: false }),
      );
      expect(capture.createAvatarFrameBitmaps).not.toHaveBeenCalled();
      expect(capture.stopAvatarCamera).not.toHaveBeenCalledWith(stream);
    }
  },
);
