// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { RelaySession } from "../../features/relay/session";
import { type PeekFollow, SearchPreview } from "./SearchPreview";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const event = (id: string, createdAt: number, content: string) => ({
  id,
  kind: 9,
  pubkey: "author",
  created_at: createdAt,
  content,
  tags: [["h", "channel"]],
});

it("holds room for a message's earlier neighbours, so the hit stays put as they load", async () => {
  vi.useFakeTimers();
  const pages: ((events: unknown[]) => void)[] = [];
  const profiles = new Map();
  const session = {
    readPage: vi.fn(
      () =>
        new Promise((resolve) => {
          pages.push((events) => resolve({ events }));
        }),
    ),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: () => Promise.resolve(),
    },
    channels: { get: () => ({}) },
  } as unknown as RelaySession;
  const lines = () => [...document.querySelectorAll(".search-peek-line")];
  const hitIndex = () =>
    lines().findIndex((line) => line.matches("[data-hit]"));
  render(
    <SearchPreview
      session={session}
      row={{
        key: "m:hit",
        label: "the hit",
        icon: ChatCircleIcon,
        run: () => {},
        peek: {
          kind: "message",
          channelId: "channel",
          messageId: "hit",
          createdAt: 1000,
          authorId: "author",
          text: "the hit",
        },
      }}
      tone="message"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#channel"}
    />,
  );
  // Two hidden slots hold the earlier lines' room before any read.
  expect(hitIndex()).toBe(2);
  expect(lines()[0]).toHaveAttribute("aria-hidden", "true");
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(pages).toHaveLength(2);
  expect(hitIndex()).toBe(2);
  await act(async () => {
    pages[0]?.([event("a", 900, "first"), event("b", 950, "second")]);
    pages[1]?.([event("c", 1100, "after")]);
  });
  // The neighbours take the slots' place: the hit is still third.
  expect(document.querySelector("[data-slot]")).toBeNull();
  expect(hitIndex()).toBe(2);
  expect(lines().map((line) => line.textContent)).toEqual([
    expect.stringContaining("first"),
    expect.stringContaining("second"),
    expect.stringContaining("the hit"),
    expect.stringContaining("after"),
  ]);
});

it("reads for a highlight nobody moved only once typing pauses and results settle", async () => {
  vi.useFakeTimers();
  const profiles = new Map();
  const session = {
    readPage: vi.fn(() => Promise.resolve({ events: [] })),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: () => Promise.resolve(),
    },
    channels: { get: () => ({}) },
  } as unknown as RelaySession;
  const preview = (follow: PeekFollow) => (
    <SearchPreview
      session={session}
      row={{
        key: "channel:design",
        label: "design",
        icon: ChatCircleIcon,
        run: () => {},
        peek: { kind: "channel", channelId: "design" },
      }}
      tone="channel"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#design"}
      follow={follow}
    />
  );
  const wait = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  // Each key restarts the pause, so a row first while someone types is not
  // read even when typing is slower than the pause on a moved highlight.
  const { rerender } = render(preview({ text: "d", busy: false }));
  await wait(250);
  rerender(preview({ text: "de", busy: false }));
  await wait(250);
  expect(session.readPage).not.toHaveBeenCalled();
  // Results that may lead are still arriving.
  rerender(preview({ text: "des", busy: true }));
  await wait(1000);
  expect(session.readPage).not.toHaveBeenCalled();
  rerender(preview({ text: "des", busy: false }));
  await wait(299);
  expect(session.readPage).not.toHaveBeenCalled();
  await wait(1);
  expect(session.readPage).toHaveBeenCalledTimes(1);
});
