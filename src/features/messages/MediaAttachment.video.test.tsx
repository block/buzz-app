// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MediaAttachment } from "./MediaAttachment";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const videoAttachment = {
  url: "https://fixture.test/video.mp4",
  kind: "video" as const,
};

function media(url: string) {
  return `media:${url}`;
}

function mockPlayback(element: HTMLVideoElement) {
  const play = vi.fn(() => {
    fireEvent.play(element);
    return Promise.resolve();
  });
  const pause = vi.fn(() => fireEvent.pause(element));
  Object.defineProperty(element, "play", { configurable: true, value: play });
  Object.defineProperty(element, "pause", { configurable: true, value: pause });
  return { play, pause };
}

it("tracks received video play, pause, time updates, and review handoff", () => {
  const onPlayback = vi.fn();
  const onOpenReview = vi.fn();
  const { container } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      onPlayback={onPlayback}
      onOpenReview={onOpenReview}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const playback = mockPlayback(video);

  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(playback.play).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();

  Object.defineProperty(video, "currentTime", {
    configurable: true,
    value: 42,
  });
  fireEvent.timeUpdate(video);
  expect(screen.getByText("0:42")).toBeInTheDocument();
  expect(onPlayback).toHaveBeenLastCalledWith({
    attachmentUrl: videoAttachment.url,
    seconds: 42,
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Open video fullscreen" }),
  );
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(onOpenReview).toHaveBeenCalledWith(videoAttachment, 42);

  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
});

it("replays an explicit seek request for a received video", () => {
  const { container, rerender } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      seekTo={12}
      seekRequest={1}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const playback = mockPlayback(video);

  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12);
  expect(playback.play).toHaveBeenCalledTimes(1);

  video.currentTime = 3;
  rerender(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      seekTo={12}
      seekRequest={2}
    />,
  );
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12);
  expect(playback.play).toHaveBeenCalledTimes(2);
});

it("shows unavailable treatment when received video playback errors", () => {
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={media} />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");

  fireEvent.error(video);

  expect(screen.getByRole("status")).toHaveTextContent("Video unavailable");
  expect(container.querySelector("video")).toBeNull();
});
