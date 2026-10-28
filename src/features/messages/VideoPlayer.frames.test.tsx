// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Profiler, useRef, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

const renders = vi.hoisted(() => ({ buttons: 0, avatars: 0 }));
vi.mock("../../shared/design-system/ui/Button", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../shared/design-system/ui/Button")
    >();
  return {
    ...actual,
    Button(props: ComponentProps<typeof actual.Button>) {
      renders.buttons++;
      return <actual.Button {...props} />;
    },
  };
});
vi.mock("../../shared/design-system/ui/Avatar", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../shared/design-system/ui/Avatar")
    >();
  return {
    ...actual,
    Avatar(props: ComponentProps<typeof actual.Avatar>) {
      renders.avatars++;
      return <actual.Avatar {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function animationFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  return {
    pending: () => callbacks.size,
    run: () =>
      act(() => {
        const due = [...callbacks.entries()];
        for (const [id, callback] of due) {
          if (callbacks.delete(id)) callback(performance.now());
        }
      }),
  };
}

function Player() {
  const video = useRef<HTMLVideoElement>(null);
  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: test fixture */}
      <video ref={video} />
      <VideoControls
        videoRef={video}
        inline
        markers={[
          {
            id: "note",
            seconds: 30,
            label: "00:30",
            author: "Ada",
            text: "Here",
          },
        ]}
      />
    </>
  );
}

it("follows playback every frame without re-rendering the other controls", () => {
  const frames = animationFrames();
  let commits = 0;
  render(
    <Profiler id="player" onRender={() => commits++}>
      <Player />
    </Profiler>,
  );
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  fireEvent.durationChange(video);
  fireEvent.play(video);
  const settled = { ...renders };
  expect(settled.avatars).toBeGreaterThan(0);
  const slider = screen.getByRole("slider", { name: "Video progress" });
  const frame = (seconds: number) => {
    video.currentTime = seconds;
    frames.run();
    expect(slider.style.getPropertyValue("--progress")).toBe(
      `${(seconds / 100) * 100}%`,
    );
  };

  for (const seconds of [12.25, 12.5, 13.75]) frame(seconds);
  // Neither the whole seconds nor the slider's 0.1s steps change here.
  const rendered = commits;
  frame(13.76);
  frame(13.79);
  expect(commits).toBe(rendered);

  expect(slider).toHaveAttribute("aria-valuetext", "00:13 / 01:40");
  expect(screen.getByText("00:13")).toBeInTheDocument();
  expect(renders).toEqual(settled);
});

it("keeps mounted players independent through pause, seek, end and unmount", () => {
  const frames = animationFrames();
  const first = render(<Player />);
  const second = render(<Player />);
  const a = first.container.querySelector("video");
  const b = second.container.querySelector("video");
  const aSlider = within(first.container).getByRole("slider", {
    name: "Video progress",
  });
  const bSlider = within(second.container).getByRole("slider", {
    name: "Video progress",
  });
  if (!a || !b) throw new Error("Missing players");
  for (const video of [a, b]) {
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });
    fireEvent.durationChange(video);
    fireEvent.play(video);
  }
  expect(frames.pending()).toBe(2);
  a.currentTime = 12.25;
  b.currentTime = 24.5;
  frames.run();
  expect(aSlider).toHaveAttribute("aria-valuetext", "00:12 / 01:40");
  expect(bSlider).toHaveAttribute("aria-valuetext", "00:24 / 01:40");
  fireEvent.pause(a);
  expect(frames.pending()).toBe(1);
  a.currentTime = 30;
  fireEvent.seeked(a);
  expect(aSlider).toHaveAttribute("aria-valuetext", "00:30 / 01:40");
  b.currentTime = 40;
  frames.run();
  expect(bSlider).toHaveAttribute("aria-valuetext", "00:40 / 01:40");
  fireEvent.play(a);
  expect(frames.pending()).toBe(2);
  first.unmount();
  expect(frames.pending()).toBe(1);
  b.currentTime = 100;
  fireEvent.ended(b);
  expect(bSlider).toHaveAttribute("aria-valuetext", "01:40 / 01:40");
  expect(frames.pending()).toBe(0);
  fireEvent.play(b);
  expect(frames.pending()).toBe(1);
  second.unmount();
  expect(frames.pending()).toBe(0);
});
