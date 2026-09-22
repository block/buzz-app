// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

it("uses attachment names in audio control labels", () => {
  render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/voice-note-1.mp4",
        kind: "audio",
        name: "voice-note-1.mp4",
        duration: 83,
      }}
      source={source}
    />,
  );

  expect(
    screen.getByRole("button", { name: "Play voice-note-1.mp4" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("slider", { name: "Seek voice-note-1.mp4" }),
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
    "0:42 of 1:23",
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

it("toggles playback from the play/pause button", async () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name: "Play audio" });

  setPaused(audio, true);
  await user.click(button);
  expect(play).toHaveBeenCalledExactlyOnceWith();
  expect(play.mock.instances[0]).toBe(audio);

  setPaused(audio, false);
  await user.click(screen.getByRole("button", { name: "Pause audio" }));
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

it("does not pause a recovered audio after unmounting it mid-playback", () => {
  const failedSource =
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ffailed.mp3";
  const recoveredSource =
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Frecovered.mp3";
  const nextSource =
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fnext.mp3";
  const attachment = {
    url: "https://fixture.test/audio.mp3",
    kind: "audio",
  } as const;
  const { container, rerender } = render(
    <StrictMode>
      <AudioAttachment
        key="recovering"
        attachment={attachment}
        source={failedSource}
      />
    </StrictMode>,
  );
  const failed = container.querySelector("audio");
  if (!failed) throw new Error("Missing failed audio element");
  fireEvent.error(failed);
  expect(screen.getByRole("status")).toHaveTextContent("Audio unavailable");

  rerender(
    <StrictMode>
      <AudioAttachment
        key="recovering"
        attachment={attachment}
        source={recoveredSource}
      />
    </StrictMode>,
  );
  const recovered = container.querySelector("audio");
  if (!recovered) throw new Error("Missing recovered audio element");
  fireEvent.play(recovered);

  rerender(
    <StrictMode>
      <AudioAttachment
        key="next"
        attachment={{ url: "https://fixture.test/next.mp3", kind: "audio" }}
        source={nextSource}
      />
    </StrictMode>,
  );
  expect(recovered).not.toBeInTheDocument();
  const next = container.querySelector("audio");
  if (!next) throw new Error("Missing next audio element");
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
