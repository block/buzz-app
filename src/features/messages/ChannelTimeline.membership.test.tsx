// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import {
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { ChannelTimeline } from "./ChannelTimeline";
import { setMembershipRowsPreference } from "./membership-preference";

// Virtualizer boundary: render only "visible" indices plus `keepMounted`,
// as Virtua does for rows scrolled out of its buffer. Layout is browser-tested.
const view = vi.hoisted(() => ({
  visible: undefined as ReadonlySet<number> | undefined,
}));
vi.mock("virtua", async () => {
  const { Children, forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        keepMounted = [],
      }: { children: ReactNode; keepMounted?: readonly number[] },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return (
        <ol>
          {Children.toArray(children).map((child, index) =>
            !view.visible ||
            view.visible.has(index) ||
            keepMounted.includes(index) ? (
              <li key={(child as ReactElement).key}>{child}</li>
            ) : null,
          )}
        </ol>
      );
    }),
  };
});

const viewer = keypair(),
  agent = keypair(),
  relay = keypair();
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  view.visible = undefined;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  setMembershipRowsPreference(true);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(initial: readonly RelayEvent[]) {
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live?.receive([
    roster(relay, "c", [viewer.pubkey, agent.pubkey], 1),
    ...initial,
  ]);
  render(
    <ChannelTimeline
      channelId="c"
      scope="viewer"
      queries={owner.session}
      window={owner.session.channels.window("c")}
      onOpenLink={() => false}
    />,
  );
}
const days = () =>
  [...document.querySelectorAll("[data-day]")].map((day) => day.textContent);

it("turning off join and leave messages leaves no day divider for a day that only had them", () => {
  const today = Math.floor(Date.now() / 1000);
  const yesterday = today - 86_400;
  const added = signed(relay, {
    kind: 40099,
    content: JSON.stringify({
      type: "member_joined",
      actor: viewer.pubkey,
      target: agent.pubkey,
    }),
    created_at: yesterday,
    tags: [["h", "c"]],
  });
  const events = [
    message(viewer, "c", "Earlier", yesterday - 86_400),
    added,
    message(viewer, "c", "Hello", today),
  ];
  mount(events);
  expect(days()).toContain("Yesterday");
  expect(document.querySelector("[data-membership-row]")).not.toBeNull();
  cleanup();
  setMembershipRowsPreference(false);
  mount(events);
  expect(days()).not.toContain("Yesterday");
  expect(days()).toContain("Today");
  expect(document.querySelector("[data-membership-row]")).toBeNull();
});
