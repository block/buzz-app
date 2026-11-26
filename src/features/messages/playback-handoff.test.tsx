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
     * frame of a position only as `presents` allows. One that `truncates`
     * goes to the whole microsecond before where it is sent, as Chromium's
     * does. One that is `late` ends a seek before the seek's event arrives,
     * having played on if it plays, as a busy page's can. Returns how to
     * load it, how to have it present the frame of its position, and the
     * media time of the frame it shows. */
    loading(
      video: HTMLVideoElement,
      presents: (to: number, from: number) => boolean,
      { rate = 24, truncates = false, late = false } = {},
    ) {
      const reached = (to: number) =>
        truncates ? Math.trunc(to * 1e6) / 1e6 : to;
      let position = video.currentTime;
      let shows: number | undefined;
      /** Seeks under way: one is from the moment it is asked for, and its
       * events arrive afterwards. Only the last one asked for ends. */
      let seeks = 0;
      /** Whether its first frame is still to arrive, which it does as the
       * seek to its start ends. */
      let first = false;
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
        seeks += 1;
        queueMicrotask(() => {
          if (late) {
            seeks -= 1;
            if (!video.paused) position += 0.02;
          }
          video.dispatchEvent(new Event("seeking"));
          queueMicrotask(() => {
            if (seeks === (late ? 0 : 1)) {
              if (first) present(0);
              first = false;
              if (presents(position, from)) present(position);
            }
            if (!late) seeks -= 1;
            if (!seeks) video.dispatchEvent(new Event("seeked"));
          });
        });
      };
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => position,
        set(to: number) {
          const from = position;
          // Until it loads, this only sets where it starts.
          position = video.readyState ? reached(to) : to;
          if (video.readyState) seek(from);
        },
      });
      video.addEventListener("play", () => present(position));
      return {
        load: () =>
          settled(() => {
            define(video, drawable);
            first = true;
            // To where it starts.
            position = reached(position);
            seek(0);
            video.dispatchEvent(new Event("loadedmetadata"));
          }),
        present: () => settled(() => present(position)),
        shows: () => shows,
      };
    },
  };
}

/** A reader opened over a brief paused at `at`, its video still to load. */
async function pausedReader(
  presents: (to: number, from: number) => boolean,
  {
    at = 42.02,
    ...engine
  }: { at?: number; rate?: number; truncates?: boolean } = {},
) {
  const frames = pictures();
  const brief = await player();
  frames.loaded(brief.video);
  await brief.press("Play video");
  brief.video.currentTime = at;
  await brief.press("Pause video");
  const reader = await player({ reader: true });
  const video = frames.loading(reader.video, presents, engine);
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

// Chromium: a video sent to a position goes to the whole microsecond before
// it, and reports that. The hand-off's own seeks are still its own.
it.each([
  // The seek to its start goes elsewhere than it was sent, and its first
  // frame is the last it has presented when that seek ends.
  { at: 8.16232, reaches: 8.162319, frame: 8.125 },
  // Sent aside, it goes elsewhere than it was sent.
  { at: 42.200002, reaches: 42.200002, frame: 1012 / 24 },
])(
  "takes its own seeks of a video that truncates them for its own (from $at)",
  async ({ at, reaches, frame }) => {
    const { reader, video } = await pausedReader(
      (to, from) => from !== 0 && to !== from,
      { at, truncates: true },
    );
    await passes(3000, () => {
      if (!reader.still()) expect(video.shows()).toBe(frame);
    });
    expect(reader.still()).toBe(false);
    expect(reader.video.currentTime).toBe(reaches);
  },
);

// A busy main thread, in Chromium and WebKit: a seek has ended by the time
// its event arrives, and the video has played on from where it was sent.
it("takes a playing reader's seek that ended before its event arrived for its own", async () => {
  const frames = pictures();
  const brief = await player();
  frames.loaded(brief.video);
  await brief.press("Play video");
  brief.video.currentTime = 42.02;
  const reader = await player({ reader: true });
  const video = frames.loading(reader.video, () => false, { late: true });
  await video.load();
  // Its first frame, reported after the seek, is all it has presented.
  expect(video.shows()).toBe(0);
  expect(reader.still()).toBe(true);
  await video.present();
  expect(video.shows()).toBe(42);
  expect(reader.still()).toBe(false);
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
  const { reader, video } = await pausedReader(() => true, { rate: 0.25 });
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
