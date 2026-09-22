// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudioAttachment } from "./AudioAttachment";

const source = "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Faudio.mp3";
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

function setDuration(element: HTMLAudioElement, duration: number) {
  Object.defineProperty(element, "duration", {
    configurable: true,
    value: duration,
  });
}

function setPaused(element: HTMLAudioElement, paused: boolean) {
  Object.defineProperty(element, "paused", {
    configurable: true,
    value: paused,
  });
}

beforeEach(() => {
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      fireEvent.play(this);
      return Promise.resolve();
    });
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(function (this: HTMLMediaElement) {
      fireEvent.pause(this);
    });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("toggles the accessible play control name", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  expect(
    screen.getByRole("button", { name: "Play audio" }),
  ).toBeInTheDocument();
  fireEvent.play(audio);
  expect(
    screen.getByRole("button", { name: "Pause audio" }),
  ).toBeInTheDocument();
  fireEvent.pause(audio);
  expect(
    screen.getByRole("button", { name: "Play audio" }),
  ).toBeInTheDocument();
});

it("shows wire duration before metadata loads", () => {
  render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  expect(screen.getByText("0:00 / 1:23")).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "83",
  );
});

it("corrects total time on finite durationchange", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  setDuration(audio, 95);
  fireEvent.durationChange(audio);
  expect(screen.getByText("0:00 / 1:35")).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "95",
  );
});

it("ignores non-finite media durations", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  setDuration(audio, Number.POSITIVE_INFINITY);
  fireEvent.durationChange(audio);
  expect(screen.getByText("0:00 / 1:23")).toBeInTheDocument();
});

it("disables seeking until a total duration is known", () => {
  render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  expect(screen.getByText("0:00")).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Seek audio" })).toBeDisabled();
});

it("updates slider value text from playback time", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  audio.currentTime = 42;
  fireEvent.timeUpdate(audio);
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "aria-valuetext",
    "0:42",
  );
});

it("sets currentTime when the seek slider changes", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  fireEvent.change(screen.getByRole("slider", { name: "Seek audio" }), {
    target: { value: "17" },
  });
  expect(audio.currentTime).toBe(17);
});

it("renders an unavailable card on load errors", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  fireEvent.error(audio);
  expect(screen.getByRole("status")).toHaveTextContent("Audio unavailable");
});

it("resets load failure when the source changes", async () => {
  const attachment = {
    url: "https://fixture.test/audio.mp3",
    kind: "audio",
  } as const;
  const { container, rerender } = render(
    <AudioAttachment attachment={attachment} source={source} />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  fireEvent.error(audio);
  expect(screen.getByRole("status")).toHaveTextContent("Audio unavailable");

  rerender(
    <AudioAttachment
      attachment={attachment}
      source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Frecovered.mp3"
    />,
  );

  await waitFor(() =>
    expect(screen.queryByRole("status")).not.toBeInTheDocument(),
  );
  expect(container.querySelector("audio")).toBeInTheDocument();
});

it("toggles playback from the play/pause button", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  const button = screen.getByRole("button", { name: "Play audio" });

  setPaused(audio, true);
  fireEvent.click(button);
  expect(play).toHaveBeenCalledExactlyOnceWith();
  expect(play.mock.instances[0]).toBe(audio);

  setPaused(audio, false);
  fireEvent.click(screen.getByRole("button", { name: "Pause audio" }));
  expect(pause).toHaveBeenCalledExactlyOnceWith();
  expect(pause.mock.instances[0]).toBe(audio);
});

it("does not pause a detached StrictMode audio after unmounting it mid-playback", () => {
  const first = (
    <AudioAttachment
      key="one"
      attachment={{ url: "https://fixture.test/one.mp3", kind: "audio" }}
      source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
    />
  );
  const second = (
    <AudioAttachment
      key="two"
      attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
      source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
    />
  );
  const { container, rerender } = render(
    <StrictMode>
      {first}
      {second}
    </StrictMode>,
  );
  const [detached] = Array.from(container.querySelectorAll("audio"));
  if (!detached) throw new Error("Missing audio element");
  fireEvent.play(detached);

  rerender(<StrictMode>{second}</StrictMode>);
  expect(detached).not.toBeInTheDocument();
  const remaining = container.querySelector("audio");
  if (!remaining) throw new Error("Missing remaining audio element");
  fireEvent.play(remaining);

  expect(pause).not.toHaveBeenCalled();
});

it("does not pause a failed StrictMode audio after it errors while playing", () => {
  const { container } = render(
    <StrictMode>
      <AudioAttachment
        attachment={{ url: "https://fixture.test/one.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
      />
      <AudioAttachment
        attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
      />
    </StrictMode>,
  );
  const [failed, next] = Array.from(container.querySelectorAll("audio"));
  if (!failed || !next) throw new Error("Missing audio elements");
  fireEvent.play(failed);
  fireEvent.error(failed);

  fireEvent.play(next);

  expect(pause).not.toHaveBeenCalled();
});

it("pauses another audio element when playback starts", () => {
  const { container } = render(
    <>
      <AudioAttachment
        attachment={{ url: "https://fixture.test/one.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
      />
      <AudioAttachment
        attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
      />
    </>,
  );
  const [first, second] = Array.from(container.querySelectorAll("audio"));
  if (!first || !second) throw new Error("Missing audio elements");
  fireEvent.play(first);
  fireEvent.play(second);
  expect(pause).toHaveBeenCalledExactlyOnceWith();
  expect(pause.mock.instances[0]).toBe(first);
  expect(play).not.toHaveBeenCalled();
});
