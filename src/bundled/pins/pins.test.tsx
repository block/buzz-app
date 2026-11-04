// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData } from "../../features/relay/events";
import type { LiveListener } from "../../features/relay/incoming";
import type { OutgoingEvent } from "../../features/relay/outbox";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { PinsPanel } from "./PinsPanel";
import { apply } from "./index";
import { channelPins, pinsSupported } from "./store";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const hex = (n: number) => n.toString(16).padStart(64, "0");
const base = createRelaySession(null).session;

const message = (n: number, content: string): EventData => ({
  id: hex(n),
  pubkey: BOB,
  kind: 9,
  created_at: 1_700_000_000,
  content,
  tags: [["h", CHANNEL]],
});
const pin = (id: string, target: string, pubkey = ALICE): EventData => ({
  id,
  pubkey,
  kind: 40004,
  created_at: 1_700_000_100,
  content: "",
  tags: [
    ["h", CHANNEL],
    ["e", target],
  ],
});

function fake({
  pins = [] as EventData[],
  messages = [] as EventData[],
  role = "member" as string | undefined,
  viewer = ALICE as string | undefined,
  kinds = [40004, 5, 9005],
} = {}) {
  const live = new Set<LiveListener>();
  const outboxListeners = new Set<() => void>();
  let pending: OutgoingEvent[] = [];
  const read = vi.fn(async (filters: readonly Record<string, unknown>[]) => {
    const [filter] = filters;
    if (filter && "ids" in filter)
      return messages.filter((event) =>
        (filter.ids as string[]).includes(event.id),
      );
    return pins;
  });
  const send = vi.fn((input: Pick<EventData, "kind" | "content" | "tags">) => {
    const id = `local-${pending.length}`;
    pending = [
      ...pending,
      {
        event: {
          ...input,
          id,
          pubkey: viewer ?? "",
          created_at: 1_700_000_200,
        },
        delivery: "pending",
      } as unknown as OutgoingEvent,
    ];
    for (const listener of outboxListeners) listener();
    return id;
  });
  const session = {
    ...base,
    viewer,
    read,
    subscribeLive(listener: LiveListener) {
      live.add(listener);
      return () => void live.delete(listener);
    },
    channels: {
      ...base.channels,
      get: (id: string) =>
        id === CHANNEL
          ? { id, name: "Team", members: [], viewerRole: role }
          : undefined,
    },
    outbox: {
      snapshot: () => pending,
      subscribe(listener: () => void) {
        outboxListeners.add(listener);
        return () => void outboxListeners.delete(listener);
      },
      supports: (kind: number) => kinds.includes(kind),
      send,
    },
  } as unknown as RelaySession;
  return {
    session,
    read,
    send,
    arrive(events: EventData[]) {
      act(() => {
        for (const listener of live) listener({ events } as never);
      });
    },
  };
}

const context = {
  scope: "pins-test",
  channelId: CHANNEL,
  channelName: "Team",
  viewer: ALICE,
  relayUrl: "",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows pins from history, live arrivals and local sends, and drops removed ones", async () => {
  const f = fake({ pins: [pin("p1", hex(1))] });
  const store = channelPins(f.session, CHANNEL);
  const changes = vi.fn();
  store.subscribe(changes);
  await waitFor(() => expect(store.snapshot().status).toBe("ready"));
  expect(f.read).toHaveBeenCalledWith([
    { kinds: [40004], "#h": [CHANNEL], limit: 200 },
  ]);
  expect(store.snapshot().byMessage.get(hex(1))?.id).toBe("p1");

  f.arrive([{ ...pin("p2", hex(2), BOB), created_at: 1_700_000_150 }]);
  store.pin(hex(3));
  expect(f.send).toHaveBeenLastCalledWith({
    kind: 40004,
    content: "",
    tags: [
      ["h", CHANNEL],
      ["e", hex(3)],
    ],
  });
  expect(store.snapshot().pins.map((p) => p.messageId)).toEqual([
    hex(3),
    hex(2),
    hex(1),
  ]);

  f.arrive([
    {
      ...pin("d1", hex(9)),
      kind: 5,
      tags: [
        ["e", "p1"],
        ["k", "40004"],
      ],
    },
  ]);
  expect(store.snapshot().byMessage.has(hex(1))).toBe(false);
  expect(channelPins(f.session, CHANNEL)).toBe(store);
});

it("needs a viewer and every pin kind in the outbox", () => {
  expect(pinsSupported(fake().session)).toBe(true);
  expect(pinsSupported(fake({ viewer: "" }).session)).toBe(false);
  expect(pinsSupported(fake({ kinds: [40004, 5] }).session)).toBe(false);
});

it("lists pinned messages, opens them, and unpins only what the viewer may", async () => {
  const f = fake({
    pins: [pin("p1", hex(1)), pin("p2", hex(2), BOB)],
    messages: [message(1, "Ship notes"), message(2, "Launch plan")],
  });
  const openMessage = vi.fn(async () => true);
  const user = userEvent.setup();
  render(
    <PinsPanel
      session={f.session}
      context={context}
      close={vi.fn()}
      openMessage={openMessage}
    />,
  );
  await screen.findByText("Ship notes");
  expect(screen.getByText("Launch plan")).toBeInTheDocument();
  const unpins = screen.getAllByRole("button", { name: /^Unpin message/ });
  expect(unpins).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: /Ship notes/ }));
  expect(openMessage).toHaveBeenCalledWith(hex(1));

  await user.click(unpins[0] as HTMLElement);
  expect(f.send).toHaveBeenLastCalledWith({
    kind: 5,
    content: "",
    tags: [
      ["h", CHANNEL],
      ["e", "p1"],
      ["k", "40004"],
    ],
  });
  await waitFor(() =>
    expect(screen.queryByText("Ship notes")).not.toBeInTheDocument(),
  );
});

it("lets admins remove anyone's pin with a moderation event", async () => {
  const f = fake({
    role: "admin",
    pins: [pin("p2", hex(2), BOB)],
    messages: [message(2, "Launch plan")],
  });
  render(
    <PinsPanel
      session={f.session}
      context={context}
      close={vi.fn()}
      openMessage={vi.fn(async () => true)}
    />,
  );
  await screen.findByText("Launch plan");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /^Unpin message/ }));
  expect(f.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 9005 }),
  );
});

it("explains how to pin when the channel has none, and marks a deleted target", async () => {
  const empty = fake();
  render(
    <PinsPanel
      session={empty.session}
      context={context}
      close={vi.fn()}
      openMessage={vi.fn(async () => true)}
    />,
  );
  expect(await screen.findByText("No pinned messages")).toBeInTheDocument();
  cleanup();

  const gone = fake({ pins: [pin("p1", hex(1))] });
  render(
    <PinsPanel
      session={gone.session}
      context={context}
      close={vi.fn()}
      openMessage={vi.fn(async () => true)}
    />,
  );
  expect(
    await screen.findByText("This message is no longer available."),
  ).toBeInTheDocument();
});

it("registers a channel launcher and a pin action for top-level, delivered messages from members", () => {
  const panels = { register: vi.fn() };
  const conversation = { registerMessageAction: vi.fn() };
  apply({
    panels,
    conversation,
    relay: { subscribe: () => () => {}, snapshot: () => ({}) },
    navigation: { open: vi.fn() },
    effect: () => {},
  } as unknown as Parameters<typeof apply>[0]);
  expect(panels.register).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pins", channelPlacement: "side" }),
  );
  const action = conversation.registerMessageAction.mock.calls[0]?.[0];
  expect(action).toMatchObject({ id: "pin", placement: "menu" });
  const top = { id: hex(1), channelId: CHANNEL };
  expect(action.matches(top, fake().session)).toBe(true);
  expect(action.matches({ ...top, threadRootId: hex(2) }, fake().session)).toBe(
    false,
  );
  expect(action.matches({ ...top, delivery: "pending" }, fake().session)).toBe(
    false,
  );
  expect(action.matches(top, fake({ role: "guest" }).session)).toBe(false);
  expect(action.matches(top, fake({ kinds: [] }).session)).toBe(false);
});
