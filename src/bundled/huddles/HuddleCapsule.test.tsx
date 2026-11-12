// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import type { HuddleWindow } from "../../features/huddle/window";
import type { HuddleSnapshot, Huddles } from "../../features/huddle/service";
import type { RelayData } from "../../features/relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { HuddleCapsule } from "./HuddleCapsule";

afterEach(cleanup);

const viewer = "owner";
const room = "00000000-0000-4000-8000-000000000002";
const destination = {
  scope: "scope",
  viewer,
  relayUrl: "wss://example.org",
  channelId: "dm",
  channelName: "Atlas",
};
const dropped: HuddleSnapshot = {
  phase: "error",
  error: "Huddle disconnected.",
  dropped: true,
  room,
  destination,
  muted: false,
  participants: [],
};

const { room: _room, ...roomless } = dropped;

function mount({
  call = dropped,
  live = true,
  joinable = true,
  voiceAgent = false,
}: {
  call?: HuddleSnapshot;
  live?: boolean;
  joinable?: boolean;
  voiceAgent?: boolean;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const start = {
    id: "1".repeat(64),
    pubkey: viewer,
    kind: 48100,
    created_at: now - 60,
    content: JSON.stringify({ ephemeral_channel_id: room }),
    tags: [["h", "dm"]],
    sig: "",
  };
  // Stores return the same snapshot until they change.
  const profiles = new Map();
  const lifecycle = { status: "ready", events: live ? [start] : [] };
  const choices = {
    pending: false,
    archives: { status: "ready" },
    selectable: [{ pubkey: "agent" }],
  };
  const channels = {
    status: "ready",
    channels: [
      {
        id: "dm",
        channelType: "dm",
        members: [viewer, "agent"],
        archived: false,
      },
    ],
  };
  const session = {
    relayAuthor: viewer,
    profiles: { subscribe: () => () => {}, snapshot: () => profiles },
    observe: () => ({
      snapshot: () => lifecycle,
      subscribe: () => () => {},
      refresh: async () => {},
      dispose: () => {},
    }),
    agentChoices: {
      subscribe: () => () => {},
      snapshot: () => choices,
      ensure: () => {},
      retain: () => () => {},
    },
    channels: { list: () => channels },
  };
  const connection = { status: "ready", scope: "scope", viewer, session };
  const relay = {
    subscribe: () => () => {},
    snapshot: () => connection,
  } as unknown as RelayData;
  const huddles = {
    subscribe: () => () => {},
    snapshot: () => call,
    canJoin: vi.fn(() => joinable),
    join: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
  };
  const roster = {
    status: "ready",
    running: voiceAgent
      ? [
          {
            pubkey: "agent",
            name: "Atlas",
            owner: viewer,
            relay: "https://example.org",
            place: "here",
            type: "test/voice",
          },
        ]
      : [],
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => roster,
    types: () => [{ key: "test/voice", voice: () => {} }],
  } as unknown as Agents;
  const presentation = {};
  const companion = {
    subscribe: () => () => {},
    snapshot: () => presentation,
  } as unknown as HuddleWindow;
  render(
    <ToastProvider>
      <HuddleCapsule
        huddles={huddles as unknown as Huddles}
        relay={relay}
        companion={companion}
        agents={agents}
      />
    </ToastProvider>,
  );
  return huddles;
}

it("joins a dropped call’s room again while it is still live, without asking", async () => {
  const huddles = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Join again" }));
  expect(huddles.join).toHaveBeenCalledExactlyOnceWith(destination, room);
  expect(huddles.start).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it.each([
  ["the call never reached a room", { call: roomless }],
  ["its room has ended", { live: false }],
  ["the relay refused its room", { joinable: false }],
])("asks before starting a new call when %s", async (_case, options) => {
  const huddles = mount(options);
  fireEvent.click(await screen.findByRole("button", { name: "Join again" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Start a huddle?",
  });
  expect(dialog).toHaveTextContent(
    "Your microphone will turn on, and others in this conversation can join.",
  );
  expect(huddles.join).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(huddles.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Join again" }));
  fireEvent.click(
    within(
      await screen.findByRole("alertdialog", { name: "Start a huddle?" }),
    ).getByRole("button", { name: "Start huddle" }),
  );
  expect(huddles.start).toHaveBeenCalledExactlyOnceWith(destination);
});

it("names the voice agent a new call in its DM would invite", async () => {
  const huddles = mount({ live: false, voiceAgent: true });
  fireEvent.click(await screen.findByRole("button", { name: "Join again" }));
  expect(
    await screen.findByRole("alertdialog", { name: "Start a huddle?" }),
  ).toHaveTextContent(
    "Your microphone will turn on and Atlas will join automatically.",
  );
  expect(huddles.start).not.toHaveBeenCalled();
});

it("logs unmapped native text instead of showing it", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mount({ call: { ...dropped, error: "Invalid Huddle update" } });
    const notice = await screen.findByRole("dialog", {
      name: "Huddle disconnected",
    });
    expect(notice).toHaveTextContent(
      "Something went wrong with the Huddle connection.",
    );
    expect(notice).not.toHaveTextContent("Invalid Huddle update");
    expect(within(notice).queryByText("Details")).toBeNull();
    expect(
      within(notice).getByRole("button", { name: "Join again" }),
    ).toBeVisible();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Huddle failed:",
      "Invalid Huddle update",
    );
  } finally {
    warn.mockRestore();
  }
});
