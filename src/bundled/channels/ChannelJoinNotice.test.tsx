// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ChannelLifecycleCapability,
  ChannelLifecycleUnconfirmed,
} from "../../features/relay/channel-lifecycle";
import { ChannelJoinNotice } from "./ChannelJoinNotice";

afterEach(cleanup);

function lifecycle(
  run: ChannelLifecycleCapability["run"],
  available = true,
): ChannelLifecycleCapability {
  return { available, run } as ChannelLifecycleCapability;
}

it("offers Join only for a joinable channel on a connection that can send it", () => {
  const run = vi.fn();
  const { rerender } = render(
    <ChannelJoinNotice
      channelId="open"
      lifecycle={lifecycle(run, false)}
      joinable
      onJoin={() => {}}
    />,
  );
  expect(screen.getByText(/Read-only preview/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Join channel" })).toBeNull();
  rerender(
    <ChannelJoinNotice
      channelId="open"
      lifecycle={lifecycle(run)}
      joinable={false}
      onJoin={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Join channel" })).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it("joins once, reports its start, and keeps a failed join retryable", async () => {
  let settle: { resolve(): void; reject(error: unknown): void } | undefined;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  const started = vi.fn();
  render(
    <ChannelJoinNotice
      channelId="open"
      lifecycle={lifecycle(run)}
      joinable
      onJoin={started}
    />,
  );
  const button = screen.getByRole("button", { name: "Join channel" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(run).toHaveBeenCalledOnce();
  // The page owns focus handoff; membership may arrive before the run settles.
  expect(started).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith("join", "open", expect.any(AbortSignal));
  expect(button).toHaveAttribute("aria-disabled", "true");
  await act(async () =>
    settle?.reject(new ChannelLifecycleUnconfirmed(new Error("timeout"))),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Join may have taken effect, but it is not confirmed yet. Try again to check.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Join channel" }));
  expect(run).toHaveBeenCalledTimes(2);
  expect(started).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => settle?.resolve());
  expect(
    screen.getByRole("button", { name: "Join channel" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});
