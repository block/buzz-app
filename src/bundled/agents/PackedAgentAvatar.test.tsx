// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
const motion = vi.hoisted(() => ({ reduced: false }));
const codecs = vi.hoisted(() => ({ native: false }));
vi.mock("../../features/agents/avatar-packs", async (original) => {
  const actual =
    await original<typeof import("../../features/agents/avatar-packs")>();
  return {
    ...actual,
    avatarAnimation: (id: string) => ({
      ...actual.avatarAnimation(id),
      ...(codecs.native ? { webm: undefined } : {}),
    }),
  };
});
vi.mock("motion/react", () => ({ useReducedMotion: () => motion.reduced }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  motion.reduced = false;
  codecs.native = false;
});
it.each([
  ["AppleWebKit Safari", ".mp4"],
  ["AppleWebKit Chrome", ".webm"],
])(
  "plays the selected animation on %s and falls back on failure",
  (userAgent, extension) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    const avatar = agentAvatars[0];
    if (!avatar) throw new Error("Missing fixture avatar");
    const view = render(<PackedAgentAvatar avatar={avatar} />);
    const video = view.container.querySelector("video");
    if (!video) throw new Error("Missing selected animation");
    expect(video).toHaveAttribute("autoplay");
    expect(video).toHaveAttribute("playsinline");
    expect(video.querySelectorAll("source")).toHaveLength(2);
    expect(video.querySelector("source")?.src).toContain(extension);
    fireEvent.error(video);
    expect(screen.getByRole("img", { name: avatar.label })).toHaveAttribute(
      "src",
      avatar.preview,
    );
    const next = agentAvatars[1];
    if (!next) throw new Error("Missing second fixture avatar");
    view.rerender(<PackedAgentAvatar avatar={next} />);
    expect(view.container.querySelector("video")).not.toBeNull();
  },
);
it("uses a still poster for reduced motion without loading video", () => {
  motion.reduced = true;
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  expect(view.container.querySelector("video")).toBeNull();
  expect(screen.getByRole("img", { name: avatar.label })).toBeVisible();
});

it("continues the outgoing avatar frame before showing the incoming video", () => {
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const outgoing = render(<PackedAgentAvatar avatar={avatar} />);
  const oldVideo = outgoing.container.querySelector("video");
  if (!oldVideo) throw new Error("Missing outgoing video");
  Object.defineProperty(oldVideo, "readyState", { value: 4 });
  Object.defineProperty(oldVideo, "paused", { value: false });
  oldVideo.currentTime = 2.5;
  const incoming = render(<PackedAgentAvatar avatar={avatar} />);
  const newVideo = incoming.container.querySelector("video");
  if (!newVideo) throw new Error("Missing incoming video");
  fireEvent.loadedData(newVideo);
  expect(newVideo.currentTime).toBe(2.5);
  expect(newVideo).toHaveStyle({ opacity: "0" });
  fireEvent.seeked(newVideo);
  expect(newVideo).toHaveStyle({ opacity: "1" });
});

it("starts muted inline playback without native controls", () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing avatar video");
  fireEvent.canPlay(video);
  expect(play).toHaveBeenCalledOnce();
  expect(video.muted).toBe(true);
  expect(video.defaultMuted).toBe(true);
  expect(video.controls).toBe(false);
  expect(video).toHaveAttribute("playsinline");
});

it("keeps animation available after autoplay is blocked and retries on hover", async () => {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(new DOMException("Blocked", "NotAllowedError"))
    .mockResolvedValue();
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  fireEvent.canPlay(video);
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector("video")).toBe(video);
  fireEvent.pointerEnter(video.parentElement as HTMLElement);
  expect(play).toHaveBeenCalledTimes(2);
});

it("omits the unbundled codec and falls back when the sole native source fails", () => {
  codecs.native = true;
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const sources = view.container.querySelectorAll("source");
  expect(sources).toHaveLength(1);
  expect(sources[0]?.src).toContain(".mp4");
  const source = sources[0];
  if (!source) throw new Error("Missing native source");
  fireEvent.error(source);
  expect(screen.getByRole("img", { name: avatar.label })).toHaveAttribute(
    "src",
    avatar.preview,
  );
});
