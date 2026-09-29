// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelaySession } from "../../features/relay/session";
import type {
  ThreadActivityItem,
  ThreadActivitySnapshot,
} from "../../features/relay/unread";

afterEach(cleanup);

test("activity keeps profile loading lazy, explains stale results and opens the selected thread", async () => {
  const user = userEvent.setup();
  const item: ThreadActivityItem = {
    channelId: "studio",
    rootId: "thread",
    latestMessageId: "message",
    authorId: "alex",
    createdAt: 1,
    preview: "Please review the designs",
    unread: { status: "at_least", value: 2 },
  };
  const snapshot: ThreadActivitySnapshot = {
    channelId: "studio",
    items: [item],
    complete: false,
    freshness: "stale",
  };
  const profiles = new Map([["alex", { name: "Alex" }]]);
  const ensure = vi.fn(async () => {});
  const open = vi.fn();
  const hydrate = vi.fn(async () => {});
  const session = {
    unread: {
      activity: () => snapshot,
      subscribeActivity: () => () => {},
      loadActivity: hydrate,
    },
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
  } as unknown as RelaySession;
  render(
    <ChannelActivityPopover
      session={session}
      channelId="studio"
      channelName="Studio"
      trigger={<Button>Activity</Button>}
      onOpenThread={open}
    />,
  );
  expect(ensure).not.toHaveBeenCalled();
  expect(hydrate).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Activity" }));
  expect(
    await screen.findByRole("dialog", { name: "Activity in Studio" }),
  ).toBeVisible();
  expect(ensure).toHaveBeenCalledExactlyOnceWith(["alex"], "background");
  expect(screen.getByText("May be out of date")).toBeVisible();
  expect(
    screen.getByText("More activity may be in this channel"),
  ).toBeVisible();
  expect(screen.getByText(/At least 2 unread/)).toBeVisible();
  expect(hydrate).toHaveBeenCalledExactlyOnceWith("studio");
  await user.click(
    screen.getByRole("button", {
      name: "Open unread thread from Alex: Please review the designs",
    }),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(item);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
