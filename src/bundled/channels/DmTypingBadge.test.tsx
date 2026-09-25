// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { LiveCallbacks } from "../../features/relay/live";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "../../features/relay/testing";
import { ChannelSidebarItem } from "./ChannelSidebarItem";
import { formatTypingLabel } from "./DmTypingBadge";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = 1_800_000_000;

it("formats the exact base composer copy", () => {
  expect(formatTypingLabel(["A"])).toBe("A is typing...");
  expect(formatTypingLabel(["A", "B"])).toBe("A and B are typing...");
  expect(formatTypingLabel(["A", "B", "C"])).toBe("A, B, and C are typing...");
  expect(formatTypingLabel(["A", "B", "C", "D", "E"])).toBe(
    "A, B, and 3 others are typing...",
  );
});

it("shows live remote typing on the matching 1:1 and group DM rows only", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair(),
    bob = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const channels: ChannelSummary[] = [
    {
      id: "dm",
      name: "Alice",
      channelType: "dm",
      participants: [alice.pubkey],
    },
    {
      id: "group",
      name: "Group",
      channelType: "dm",
      participants: [alice.pubkey, bob.pubkey],
    },
    {
      id: "other",
      name: "Other",
      channelType: "dm",
      participants: [bob.pubkey],
    },
    { id: "stream", name: "Stream", channelType: "stream" },
  ];
  const commits = new Map<string, number>();
  const renderRows = (selected?: string) =>
    channels.map((channel) => (
      <div key={channel.id} data-testid={channel.id}>
        <Profiler
          id={channel.id}
          onRender={(id) => commits.set(id, (commits.get(id) ?? 0) + 1)}
        >
          <ChannelSidebarItem
            channel={channel}
            session={owner.session}
            working={false}
            selected={selected}
            collapsed={false}
            onToggle={() => {}}
            draft={false}
            draftSelected={false}
            sessions={undefined}
            onSelect={() => {}}
            onNewSession={() => {}}
            onOpenThread={() => {}}
          />
        </Profiler>
      </div>
    ));
  const view = render(<div>{renderRows()}</div>);
  live.state({ status: "connected", routes: [] });
  act(() =>
    live.receive(
      channels.map((channel) =>
        roster(relay, channel.id, [viewer.pubkey, alice.pubkey, bob.pubkey]),
      ),
    ),
  );
  const pulse = (
    key: Key,
    channelId: string,
    at = NOW,
    root?: string,
    kind = 20002,
  ) =>
    signed(key, {
      kind,
      content: kind === 9 ? "hi" : "",
      created_at: at,
      tags: [["h", channelId], ...(root ? [["e", root, "", "reply"]] : [])],
    });
  const name = (key: Key) => key.pubkey.slice(0, 10);
  const typing = (row: string) =>
    within(screen.getByTestId(row)).queryByRole("img", {
      name: /typing\.\.\.$/,
    });
  const allTyping = () => screen.queryAllByRole("img", { name: /typing/ });

  // Self events and regular channel rows never show sidebar typing.
  act(() =>
    live.receive([
      pulse(viewer, "dm"),
      pulse(viewer, "group"),
      pulse(alice, "stream"),
    ]),
  );
  expect(allTyping()).toEqual([]);

  const idle = [commits.get("other"), commits.get("stream")];
  act(() => live.receive([pulse(alice, "dm")]));
  // Only the affected row re-renders.
  expect([commits.get("other"), commits.get("stream")]).toEqual(idle);
  const badge = typing("dm");
  expect(badge).toHaveAttribute("aria-label", `${name(alice)} is typing...`);
  expect(badge).toHaveAttribute("title", `${name(alice)} is typing...`);
  expect(allTyping()).toHaveLength(1);

  // Switching the selected conversation keeps typing on its own row.
  view.rerender(<div>{renderRows("other")}</div>);
  expect(typing("dm")).toBeInTheDocument();
  expect(typing("other")).toBeNull();

  // Group DM: thread and top-level scopes combine; one signer appears once.
  const root = "f".repeat(64);
  act(() =>
    live.receive([
      pulse(alice, "group"),
      pulse(alice, "group", NOW, root),
      pulse(bob, "group", NOW, root),
    ]),
  );
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `${name(alice)} and ${name(bob)} are typing...`,
  );
  // Alice's thread message clears only that scope; her top-level typing remains.
  act(() => live.receive([pulse(alice, "group", NOW, root, 9)]));
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `${name(alice)} and ${name(bob)} are typing...`,
  );
  // Bob's thread message stops Bob only.
  act(() => live.receive([pulse(bob, "group", NOW, root, 9)]));
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `${name(alice)} is typing...`,
  );

  // Expiry: visible until eight seconds after the last signed pulse.
  act(() => vi.advanceTimersByTime(7_999));
  expect(typing("dm")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(allTyping()).toEqual([]);

  // Stale pulses are ignored; disconnect clears live typing.
  act(() => live.receive([pulse(alice, "dm", NOW)]));
  expect(allTyping()).toEqual([]);
  act(() => live.receive([pulse(alice, "dm", NOW + 8)]));
  expect(typing("dm")).toBeInTheDocument();
  act(() => live.state({ status: "retrying", routes: [] }));
  expect(allTyping()).toEqual([]);

  view.unmount();
  owner.dispose();
});
