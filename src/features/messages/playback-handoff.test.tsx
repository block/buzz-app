// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { MediaAttachment } from "./MediaAttachment";

// No media listener: `media_stream_base` reports none.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const setPaused = (video: HTMLMediaElement, paused: boolean) =>
  Object.defineProperty(video, "paused", { configurable: true, value: paused });

// Media elements as a browser has them: play and pause take effect at once,
// and their events arrive afterwards.
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this.paused) {
      setPaused(this, false);
      queueMicrotask(() => this.dispatchEvent(new Event("play")));
    }
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this.paused) return;
    setPaused(this, true);
    queueMicrotask(() => this.dispatchEvent(new Event("pause")));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const attachment = {
  url: "https://fixture.test/video.mp4",
  kind: "video" as const,
};

/** Runs `change` and lets the media events it queues arrive. */
const settled = (change: () => void) => act(async () => change());

async function player({
  reader = false,
  shown = true,
  // A reader's video is still loading when it opens.
  loaded = !reader,
  strict = false,
}: {
  reader?: boolean;
  shown?: boolean;
  loaded?: boolean;
  strict?: boolean;
} = {}) {
  let view!: ReturnType<typeof render>;
  const element = (
    <ConversationPresentation value={shown}>
      <MediaAttachment
        attachment={attachment}
        media={(url) => `media:${url}`}
        handoff={{ messageId: "details", reader }}
      />
    </ConversationPresentation>
  );
  await settled(() => {
    view = render(strict ? <StrictMode>{element}</StrictMode> : element);
  });
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  const load = () =>
    settled(() => {
      Object.defineProperty(video, "readyState", {
        configurable: true,
        value: HTMLMediaElement.HAVE_METADATA,
      });
      video.dispatchEvent(new Event("loadedmetadata"));
    });
  if (loaded) await load();
  const controls = within(view.container);
  return {
    video,
    controls,
    load,
    press: (name: string) =>
      settled(() => controls.getByRole("button", { name }).click()),
    close: () => settled(() => view.unmount()),
  };
}

it.each([true, false])(
  "moves a details video's playback into its reader and back (playing: %s)",
  async (playing) => {
    const brief = await player();
    await brief.press("Play video");
    brief.video.currentTime = 42;
    brief.video.volume = 0.25;
    brief.video.muted = true;
    if (!playing) await brief.press("Pause video");

    const reader = await player({ reader: true });
    // The brief falls silent, and the reader starts with the press that
    // opened it rather than once its video loads.
    expect(brief.video.paused).toBe(true);
    expect(reader.video.paused).toBe(!playing);
    await reader.load();
    expect(reader.video.currentTime).toBe(42);
    expect(reader.video.paused).toBe(!playing);
    expect(reader.video.volume).toBe(0.25);
    expect(reader.video.muted).toBe(true);
    // Paused, it still shows its position and frame rather than its poster.
    expect(reader.controls.getByText("00:42")).toBeInTheDocument();
    expect(reader.video.closest("[data-video-preview]")).toHaveAttribute(
      "data-started",
    );
    expect(
      reader.controls.getByRole("button", {
        name: playing ? "Pause video" : "Play video",
      }),
    ).toBeInTheDocument();

    reader.video.currentTime = 50;
    reader.video.volume = 0.5;
    reader.video.muted = false;
    await reader.close();
    expect(brief.video.currentTime).toBe(50);
    expect(brief.video.paused).toBe(!playing);
    expect(brief.video.volume).toBe(0.5);
    expect(brief.video.muted).toBe(false);
    expect(brief.controls.getByText("00:50")).toBeInTheDocument();
  },
);

// React replays a mount in development: the reader hands playback back and
// takes it again, and the brief's play event from the hand back arrives after.
it("returns the handed position when the reader closes before its video loads", async () => {
  const brief = await player({ strict: true });
  await brief.press("Play video");
  brief.video.currentTime = 42;
  const reader = await player({ reader: true, strict: true });
  expect(brief.video.paused).toBe(true);
  expect(reader.video.paused).toBe(false);
  await reader.close();
  expect(brief.video.currentTime).toBe(42);
  expect(brief.video.paused).toBe(false);
});

it("leaves playback with a brief that took it back while the reader was open", async () => {
  const brief = await player();
  await brief.press("Play video");
  brief.video.currentTime = 12;
  const reader = await player({ reader: true });
  reader.video.volume = 0.2;
  reader.video.muted = true;
  // Started again before the reader's video has loaded.
  await brief.press("Play video");
  expect(reader.video.paused).toBe(true);
  await reader.load();
  // The reader takes its place without starting over the brief.
  expect(reader.video.currentTime).toBe(12);
  expect(reader.video.paused).toBe(true);
  expect(brief.video.paused).toBe(false);

  reader.video.currentTime = 30;
  await reader.close();
  expect(brief.video.currentTime).toBe(12);
  expect(brief.video.paused).toBe(false);
  expect(brief.video.volume).toBe(1);
  expect(brief.video.muted).toBe(false);
});

it("plays a video in one of its briefs at a time, and reads the one that plays", async () => {
  const timeline = await player();
  const thread = await player();
  await timeline.press("Play video");
  timeline.video.currentTime = 5;
  await thread.press("Play video");
  expect(timeline.video.paused).toBe(true);
  thread.video.currentTime = 20;

  const reader = await player({ reader: true, loaded: true });
  expect(reader.video.currentTime).toBe(20);
  expect(reader.video.paused).toBe(false);
  expect(thread.video.paused).toBe(true);
  reader.video.currentTime = 25;
  await reader.close();
  expect(thread.video.currentTime).toBe(25);
  expect(thread.video.paused).toBe(false);
  expect(timeline.video.currentTime).toBe(5);
  expect(timeline.video.paused).toBe(true);
});

it("stops with the reader rather than start a brief in a hidden view", async () => {
  const hidden = await player({ shown: false });
  const brief = await player();
  await brief.press("Play video");
  const reader = await player({ reader: true, loaded: true });
  reader.video.currentTime = 30;
  await brief.close();
  await reader.close();
  expect(hidden.video.paused).toBe(true);
  expect(hidden.video.currentTime).toBe(0);
});

it("leaves a reader the browser will not start paused at the position", async () => {
  const brief = await player();
  await brief.press("Play video");
  brief.video.currentTime = 42;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() =>
    Promise.reject(new DOMException("Refused", "NotAllowedError")),
  );
  const reader = await player({ reader: true, loaded: true });
  expect(brief.video.paused).toBe(true);
  expect(reader.video.paused).toBe(true);
  expect(reader.video.currentTime).toBe(42);
  expect(
    reader.controls.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  expect(reader.controls.getByText("00:42")).toBeInTheDocument();
  await reader.close();
  expect(brief.video.paused).toBe(true);
  expect(brief.video.currentTime).toBe(42);
});
