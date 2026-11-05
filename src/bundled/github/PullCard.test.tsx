// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import { PullCard } from "./PullCard";
import type { RelayPull, PullRecord } from "./relay-pull";
import type { PullSources, RelayPulls } from "./relay-pulls";

afterEach(cleanup);

const nameOf = (pubkey: string) => (pubkey === "c".repeat(64) ? "Mike" : "?");
const relayAuthor = "a".repeat(64);

const channelId = "11111111-1111-4111-8111-111111111111";
const url = "https://github.com/block/buzz-app/pull/7";
const message = {
  id: "b".repeat(64),
  channelId,
  authorId: relayAuthor,
  content: `#7 · Add the card\n${url}`,
} as unknown as ChannelMessage;

const pull = (extra: Partial<RelayPull> = {}): RelayPull => ({
  url,
  repo: "block/buzz-app",
  number: 7,
  title: "Add the card",
  author: "joah",
  state: "open",
  checks: { state: "failure", runs: {} },
  reviews: { ana: "approved", bo: "changes_requested" },
  requestedReviewers: ["team:core"],
  ...extra,
});

function setup(initial?: PullRecord) {
  let record = initial;
  const listeners = new Set<() => void>();
  const stop = vi.fn();
  const watch = vi.fn(() => stop);
  const byRoot = vi.fn((_id: string, author: string) =>
    record && (record.publisher ?? relayAuthor) === author ? record : undefined,
  );
  const pulls = { watch, byRoot } as unknown as RelayPulls;
  const sources = {
    selected: () => pulls,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PullSources;
  return {
    sources,
    watch,
    byRoot,
    stop,
    update(next: RelayPull, publisher?: string) {
      record = {
        id: "x",
        channel: channelId,
        createdAt: 2,
        pull: next,
        ...(publisher && { publisher }),
      };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

it("shows the announcement's own words until the relay has a record, then the pull request's state, live", () => {
  const { sources, watch, update } = setup();
  render(
    <PullCard
      message={message}
      sources={sources}
      nameOf={nameOf}
      open={() => false}
      canOpen={() => false}
    />,
  );
  expect(watch).toHaveBeenCalledWith(channelId);
  expect(
    screen.getByRole("link", { name: "#7 · Add the card" }),
  ).toHaveAttribute("href", url);
  expect(screen.queryByText("block/buzz-app")).not.toBeInTheDocument();

  update(pull());
  expect(screen.getByRole("link", { name: "#7 · Add the card" })).toBeVisible();
  expect(screen.getByText("block/buzz-app")).toBeVisible();
  expect(screen.getByText("Checks failing")).toBeVisible();
  expect(screen.getByText("Approved by ana")).toBeVisible();
  expect(screen.getByText("Changes requested by bo")).toBeVisible();
  expect(screen.getByText("Awaiting core")).toBeVisible();

  update(
    pull({
      state: "merged",
      checks: { state: "success", runs: {} },
      reviews: {},
    }),
  );
  expect(screen.getByText("block/buzz-app")).toBeVisible();
  expect(screen.queryByText("Checks failing")).not.toBeInTheDocument();
  expect(screen.queryByText("Awaiting core")).not.toBeInTheDocument();
  expect(screen.getByText("Pull request, merged")).toBeInTheDocument();
});

it("opens the pull request in the app when it can", async () => {
  const user = userEvent.setup();
  const { sources, stop } = setup();
  const open = vi.fn(() => true);
  const { unmount } = render(
    <PullCard
      message={message}
      sources={sources}
      nameOf={nameOf}
      open={open}
      canOpen={() => true}
    />,
  );
  const link = screen.getByRole("link", { name: "#7 · Add the card" });
  await user.click(link);
  expect(open).toHaveBeenCalledWith(url);
  unmount();
  expect(stop).toHaveBeenCalled();
});

it("shows a publisher's record only on that publisher's own announcement, naming them", () => {
  const publisher = "c".repeat(64);
  const { sources, update, byRoot } = setup();
  const own = { ...message, authorId: publisher } as ChannelMessage;
  const { unmount } = render(
    <PullCard
      message={own}
      sources={sources}
      nameOf={nameOf}
      open={() => false}
      canOpen={() => false}
    />,
  );
  update(pull(), publisher);
  expect(byRoot).toHaveBeenLastCalledWith(message.id, publisher);
  expect(screen.getByText("block/buzz-app")).toBeVisible();
  expect(screen.getByText("via Mike")).toBeVisible();
  unmount();

  render(
    <PullCard
      message={{ ...message, authorId: "d".repeat(64) } as ChannelMessage}
      sources={sources}
      nameOf={nameOf}
      open={() => false}
      canOpen={() => false}
    />,
  );
  expect(screen.getByRole("link", { name: "#7 · Add the card" })).toBeVisible();
  expect(screen.queryByText("block/buzz-app")).not.toBeInTheDocument();
});

it("ignores a record for a pull request other than the one the announcement links", () => {
  const { sources, update } = setup();
  render(
    <PullCard
      message={message}
      sources={sources}
      nameOf={nameOf}
      open={() => false}
      canOpen={() => false}
    />,
  );
  update(pull({ url: "https://github.com/block/buzz-app/pull/8", number: 8 }));
  expect(
    screen.getByRole("link", { name: "#7 · Add the card" }),
  ).toHaveAttribute("href", url);
  expect(screen.queryByText("block/buzz-app")).not.toBeInTheDocument();
  update(pull({ url: "https://github.com/Block/Buzz-App/pull/7" }));
  expect(screen.getByText("block/buzz-app")).toBeVisible();
});
