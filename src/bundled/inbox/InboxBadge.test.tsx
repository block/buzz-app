// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { InboxItem } from "../../features/relay/inbox";
import { InboxBadge } from "./InboxBadge";

afterEach(cleanup);

it("caps the displayed count at 99+ and keeps the exact count in its name", () => {
  const viewer = "f".repeat(64);
  const items = Array.from(
    { length: 120 },
    (_, index) =>
      ({
        unreadCount: 1,
        manual: false,
        id: `${index}`,
      }) as unknown as InboxItem,
  );
  const inbox = { items };
  const connection = {
    status: "ready",
    generation: 1,
    scope: `https://relay.test:${viewer}`,
    viewer,
    session: {
      scope: `https://relay.test:${viewer}`,
      unread: { inbox: () => inbox, subscribeInbox: () => () => {} },
    },
  };
  // useSyncExternalStore needs a stable snapshot.
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  render(<InboxBadge relay={relay} />);
  const badge = screen.getByRole("img", { name: "120 unread conversations" });
  expect(badge).toHaveTextContent(/^99\+$/);
});
