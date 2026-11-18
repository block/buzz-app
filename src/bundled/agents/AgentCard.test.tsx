// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { communityMedia } from "../../features/profiles/avatar-upload";
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
  const fetcher = vi.fn(() => registration);
  vi.stubGlobal("fetch", fetcher);
  const loads: Array<{ onload?: (() => void) | null }> = [];
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
  expect(fetcher).toHaveBeenCalledWith(
    "/api/relay/register",
    expect.objectContaining({ method: "POST" }),
  );
  await act(async () => register(Response.json({})));
  await waitFor(() =>
    expect(container.querySelector("img")).toHaveAttribute("src", thumbnail),
  );
  expect(loads).toHaveLength(1);
  act(() => loads[0]?.onload?.());
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    media(agent.picture),
  );
  act(() => {
    motion = false;
    for (const change of listeners) change();
  });
  expect(container.querySelector("img")).toHaveAttribute("src", thumbnail);
  rerender(<AgentPortrait agent={agent} community="https://community.test" />);
  expect(container.querySelector("img")).toHaveAttribute("src", thumbnail);
  unmount();
  expect(listeners.size).toBe(0);
});
