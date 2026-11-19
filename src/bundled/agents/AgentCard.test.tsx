// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { communityMedia } from "../../features/profiles/avatar-upload";
import { stubAvatarAnimationFetch } from "../../features/profiles/avatar-animation-testing";
import { AgentPortrait } from "./AgentCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("plays the expanded portrait only after protected media is ready, then keeps cards still", async () => {
  let register!: (response: Response) => void;
  const registration = new Promise<Response>((resolve) => {
    register = resolve;
  });
  const transfer = stubAvatarAnimationFetch();
  transfer.fetch.mockImplementationOnce(() => registration);
  const loads: Array<{ src: string; onload?: (() => void) | null }> = [];
  let motion = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return motion;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = null;
      constructor() {
        loads.push(this);
      }
    },
  );
  const agent = {
    name: "Example agent",
    picture: `https://community.test/media/${"a".repeat(64)}.webp`,
  };
  const media = communityMedia("https://community.test");
  const thumbnail = media(agent.picture, "small");
  const { container, rerender, unmount } = render(
    <AgentPortrait agent={agent} community="https://community.test" animate />,
  );
  expect(loads).toHaveLength(0);
  expect(container.querySelector("img")).toBeNull();
  expect(transfer.fetch).toHaveBeenCalledWith(
    "/api/relay/register",
    expect.objectContaining({ method: "POST" }),
  );
  await act(async () => register(Response.json({})));
  await waitFor(() =>
    expect(container.querySelector("img")).toHaveAttribute("src", thumbnail),
  );
  await waitFor(() => expect(loads).toHaveLength(1));
  expect(transfer.fetch).toHaveBeenCalledWith(media(agent.picture), {
    signal: expect.any(AbortSignal),
  });
  expect(loads[0]?.src).toBe("blob:avatar-1");
  const poster = container.querySelector("img");
  if (!poster) throw new Error("Expected still portrait");
  fireEvent.load(poster);
  act(() => loads[0]?.onload?.());
  expect(
    container.querySelector("img[data-avatar-foreground]"),
  ).toHaveAttribute("src", "blob:avatar-1");
  expect(container.querySelector("img")).toBe(poster);
  expect(poster).toHaveAttribute("data-loaded", "true");
  act(() => {
    motion = false;
    for (const change of listeners) change();
  });
  expect(container.querySelector("img")).toHaveAttribute("src", thumbnail);
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("img")).toBe(poster);
  expect(loads[0]?.src).toBe("");
  expect(transfer.revoke).toHaveBeenCalledWith("blob:avatar-1");
  rerender(<AgentPortrait agent={agent} community="https://community.test" />);
  expect(container.querySelector("img")).toHaveAttribute("src", thumbnail);
  expect(loads).toHaveLength(1);
  expect(transfer.fetch).toHaveBeenCalledTimes(2);
  unmount();
  expect(listeners.size).toBe(0);
});
