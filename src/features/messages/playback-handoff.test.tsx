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
  vi.useRealTimers();
  for (const name of ["requestVideoFrameCallback", "cancelVideoFrameCallback"])
    Reflect.deleteProperty(HTMLVideoElement.prototype, name);
});

const attachment = {
  url: "https://fixture.test/video.mp4",
  previewUrl: "https://fixture.test/poster.jpg",
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
    /** Whether it shows the video's poster, over the video or as its own. */
    poster: () =>
      !!view.container.querySelector("img") || video.hasAttribute("poster"),
    /** Whether a still of the frame it was handed lies over its video. */
    still: () => !!view.container.querySelector("canvas"),
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
    // While its video loads, however long, it shows no poster and reports
    // the position it was handed.
    expect(reader.poster()).toBe(false);
    expect(reader.controls.getByText("00:42")).toBeInTheDocument();
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

it("opens a video that has not played on its poster", async () => {
  const brief = await player();
  expect(brief.poster()).toBe(true);
  const reader = await player({ reader: true });
  expect(reader.poster()).toBe(true);
  await reader.load();
  expect(reader.poster()).toBe(true);
  expect(reader.video.paused).toBe(true);
});

it("keeps the poster of a video started at 0:00 that has no frame yet", async () => {
  const brief = await player();
  await brief.press("Play video");
  expect(brief.poster()).toBe(true);
  const reader = await player({ reader: true });
  expect(reader.video.paused).toBe(false);
  expect(reader.poster()).toBe(true);
});

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

const define = (video: HTMLVideoElement, values: Record<string, unknown>) => {
  for (const [name, value] of Object.entries(values))
    Object.defineProperty(video, name, { configurable: true, value });
};

/** Gives videos pictures, which jsdom's have none of: a frame a canvas can
 * draw, and frames a video reports presenting. */
function pictures() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as never);
  const waiting = new Map<HTMLVideoElement, VideoFrameRequestCallback[]>();
  Object.assign(HTMLVideoElement.prototype, {
    requestVideoFrameCallback(
      this: HTMLVideoElement,
      callback: VideoFrameRequestCallback,
    ) {
      waiting.set(this, [...(waiting.get(this) ?? []), callback]);
      return 1;
    },
    cancelVideoFrameCallback(this: HTMLVideoElement) {
      waiting.delete(this);
    },
  });
  const drawable = { readyState: 4, videoWidth: 640, videoHeight: 360 };
  return {
    /** A loaded video, showing a frame. */
    loaded: (video: HTMLVideoElement) => define(video, drawable),
    /** A video still to load, of `rate` frames a second, that presents the
     * frame of a position only as `presents` allows. Returns how to load it,
     * and the media time of the frame it shows. */
    loading(
      video: HTMLVideoElement,
      presents: (to: number, from: number) => boolean,
      rate = 24,
    ) {
      let position = video.currentTime;
      let shows: number | undefined;
      /** Seeks under way: one is from the moment it is asked for, and its
       * events arrive afterwards. */
      let seeks = 0;
      Object.defineProperty(video, "seeking", {
        configurable: true,
        get: () => seeks > 0,
      });
      const present = (seconds: number) => {
        shows = Math.floor(seconds * rate) / rate;
        const callbacks = waiting.get(video) ?? [];
        waiting.delete(video);
        for (const callback of callbacks)
          callback(0, { mediaTime: shows } as VideoFrameCallbackMetadata);
      };
      const seek = (from: number) => {
        video.dispatchEvent(new Event("seeking"));
        if (presents(position, from)) present(position);
        seeks -= 1;
        video.dispatchEvent(new Event("seeked"));
      };
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => position,
        set(to: number) {
          const from = position;
          position = to;
          // Until it loads, this only sets where it starts.
          if (!video.readyState) return;
          seeks += 1;
          queueMicrotask(() => seek(from));
        },
      });
      video.addEventListener("play", () => present(position));
      return {
        load: () =>
          settled(() => {
            define(video, drawable);
            // To where it starts.
            seeks += 1;
            video.dispatchEvent(new Event("loadedmetadata"));
            // Its first frame arrives as the seek to its start ends.
            present(0);
            seek(0);
          }),
        shows: () => shows,
      };
    },
  };
}

/** A reader opened over a brief paused at 0:42, its video still to load. */
async function pausedReader(
  presents: (to: number, from: number) => boolean,
  rate?: number,
) {
  const frames = pictures();
  const brief = await player();
  frames.loaded(brief.video);
  await brief.press("Play video");
  brief.video.currentTime = 42.02;
  await brief.press("Pause video");
  const reader = await player({ reader: true });
  const video = frames.loading(reader.video, presents, rate);
  expect(reader.still()).toBe(true);
  await video.load();
  return { reader, video };
}

/** Lets `ms` pass in steps, a video's events arriving between them, and runs
 * `check` after each. */
async function passes(ms: number, check = () => {}) {
  for (let waited = 0; waited < ms; waited += 50) {
    await settled(() => vi.advanceTimersByTime(50));
    check();
  }
}

// WebKit: the seek to a paused video's start position can end on the video's
// first frame, which stays until the video is sent to another frame.
it("lifts a paused reader's still only once its video presents the handed frame", async () => {
  const { reader, video } = await pausedReader(
    (to, from) => from !== 0 && to !== from,
  );
  expect(video.shows()).toBe(0);
  // Under the still or not, the viewer sees the handed frame.
  await passes(3000, () => {
    if (!reader.still()) expect(video.shows()).toBe(42);
  });
  expect(reader.still()).toBe(false);
  expect(reader.video.currentTime).toBe(42.02);
  expect(reader.video.paused).toBe(true);
});

it("keeps the still over a paused reader that presents no frame, until it plays", async () => {
  const { reader, video } = await pausedReader(() => false);
  await passes(5000);
  expect(reader.still()).toBe(true);
  expect(reader.video.currentTime).toBe(42.02);
  expect(reader.video.paused).toBe(true);

  await reader.press("Play video");
  expect(video.shows()).toBe(42);
  expect(reader.still()).toBe(false);
  expect(reader.video.currentTime).toBe(42.02);
  expect(
    reader.controls.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
});

// A frame every four seconds, as a recording of a still screen has: the frame
// at 0:42 began at 0:40, too long before for a frame of the position.
it("lifts the still once the viewer seeks a paused reader, onto whatever frame is there", async () => {
  const { reader, video } = await pausedReader(() => true, 0.25);
  await passes(2000);
  expect(video.shows()).toBe(40);
  expect(reader.still()).toBe(true);
  expect(reader.video.currentTime).toBe(42.02);

  await settled(() => {
    reader.video.currentTime = 50;
  });
  expect(video.shows()).toBe(48);
  expect(reader.still()).toBe(false);
  expect(reader.video.currentTime).toBe(50);
});

it("leaves a paused reader where the viewer seeks as it is brought back from aside", async () => {
  const { reader } = await pausedReader(() => false);
  // Sent aside, and 50 ms from being brought back.
  await passes(450);
  expect(reader.video.currentTime).not.toBe(42.02);
  // The seek's events are still to come when that time runs out.
  await settled(() => {
    reader.video.currentTime = 50;
    vi.advanceTimersByTime(50);
  });
  expect(reader.video.currentTime).toBe(50);
});
