// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { inactiveChat } from "./ArchiveInactiveChats";
import { SoloWorkspaces } from "./SoloWorkspaces";

const VIEWER = "a".repeat(64);
const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;
const ids = {
  old: "00000000-0000-4000-8000-000000000001",
  older: "00000000-0000-4000-8000-000000000002",
  recent: "00000000-0000-4000-8000-000000000003",
  working: "00000000-0000-4000-8000-000000000004",
  elsewhere: "00000000-0000-4000-8000-000000000005",
};

// Toast actions sit on Sonner's swipeable card, which captures the pointer.
HTMLElement.prototype.setPointerCapture ??= () => {};

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function chat(
  id: string,
  name: string,
  daysAgo: number,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name,
    channelType: "solo",
    members: [VIEWER],
    owners: [VIEWER],
    viewerRole: "owner",
    lastActivityAt: NOW - daysAgo * DAY,
    activityKnown: true,
    ...extra,
  };
}

function sessionWith(
  channels: ChannelSummary[],
  overrides: Partial<Record<keyof RelaySession, unknown>> = {},
) {
  const owner = createRelaySession(null);
  owners.push(owner);
  const list = { status: "ready", channels };
  return {
    ...owner.session,
    viewer: VIEWER,
    scope: "viewer:community",
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => ({
        status: "listening",
        turns: [
          { channelId: ids.working, agent: "b".repeat(64), state: "working" },
        ],
        typing: [],
        local: [],
      }),
    },
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: () => () => {},
    },
    ...overrides,
  } as unknown as RelaySession;
}

it("counts a chat as inactive only after 14 quiet days with nothing running", () => {
  const session = sessionWith([]);
  expect(inactiveChat(session, chat(ids.old, "Old", 15), NOW)).toBe(true);
  expect(inactiveChat(session, chat(ids.recent, "Recent", 13), NOW)).toBe(
    false,
  );
  // Without messages, creation stands in; unknown activity proves nothing.
  expect(
    inactiveChat(
      session,
      chat(ids.old, "Empty", 0, {
        lastActivityAt: undefined,
        createdAt: NOW - 20 * DAY,
      }),
      NOW,
    ),
  ).toBe(true);
  const { activityKnown: _known, ...unknown } = chat(ids.old, "Unknown", 30);
  expect(inactiveChat(session, unknown, NOW)).toBe(false);
  expect(inactiveChat(session, chat(ids.working, "Working", 30), NOW)).toBe(
    false,
  );
  expect(
    inactiveChat(
      session,
      chat(ids.old, "Member", 30, { viewerRole: "member" }),
      NOW,
    ),
  ).toBe(false);
  expect(
    inactiveChat(
      session,
      chat(ids.old, "Archived", 30, { archived: true }),
      NOW,
    ),
  ).toBe(false);
});

it("keeps a chat with a queued follow-up or a message still sending", () => {
  const sending = sessionWith([], {
    outbox: {
      snapshot: () => [
        { event: { tags: [["h", ids.old]] }, delivery: "sending" },
      ],
      subscribe: () => () => {},
      ready: () => new Promise(() => {}),
    },
  });
  expect(inactiveChat(sending, chat(ids.old, "Old", 30), NOW)).toBe(false);
});

type Run = (
  action: string,
  id: string,
  signal?: AbortSignal,
  active?: () => boolean,
) => Promise<void>;

/** A Work workspace holding `work` and a Home workspace holding `home`. */
async function mount(
  channels: ChannelSummary[],
  work: readonly string[],
  home: readonly string[],
  run: Run,
) {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  const session = sessionWith(channels, {
    channelLifecycle: { available: true, run },
  });
  const saved: SidebarPreferences = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "home", name: "Home", order: 1 },
    ],
    assignments: Object.fromEntries([
      ...work.map((id) => [id, "work"]),
      ...home.map((id) => [id, "home"]),
    ]),
    starred: [],
    muted: [],
  };
  const store = createSidebarPreferencesStore({
    read: async () => saved,
    available: true,
    write: async () => saved,
    writeStar: async () => [],
    removeSection: async () => saved,
    writeOrder: async () => saved,
    groupsOnly: true,
  });
  await store.queries.ensure();
  render(
    <ToastProvider>
      <SoloWorkspaces
        session={{ ...session, soloPreferences: store.queries } as RelaySession}
        scope="viewer:community"
        chats={channels.map((channel) => ({
          id: channel.id,
          title: channel.name,
        }))}
        renderChat={(item) => <button type="button">{item.title}</button>}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive inactive chats" }),
  );
  return { user, store, dialog: await screen.findByRole("alertdialog") };
}

it("confirms the count, archives each inactive chat in the workspace, and undoes it", async () => {
  const run = vi.fn<Run>(async () => {});
  const { user, store, dialog } = await mount(
    [
      chat(ids.old, "Old plan", 15),
      chat(ids.recent, "Recent plan", 2),
      chat(ids.working, "Running plan", 30),
      chat(ids.older, "Older plan", 40),
      chat(ids.elsewhere, "Other workspace", 30),
    ],
    [ids.old, ids.recent, ids.working, ids.older],
    [ids.elsewhere],
    run,
  );
  expect(dialog).toHaveTextContent(
    "2 chats have been inactive for the last 14 days. Archive them?",
  );
  await user.click(screen.getByRole("button", { name: "Archive 2 chats" }));
  expect(await screen.findByText("Archived 2 chats")).toBeVisible();
  expect(screen.getByRole("button", { name: "Work" })).toHaveFocus();
  expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["archive", ids.old],
    ["archive", ids.older],
  ]);
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Restored 2 chats")).toBeVisible();
  expect(run.mock.calls.slice(2).map((call) => call.slice(0, 2))).toEqual([
    ["unarchive", ids.old],
    ["unarchive", ids.older],
  ]);
  store.dispose();
});

it("skips a chat that becomes active before its archive publishes", async () => {
  const channels = [
    chat(ids.old, "Old plan", 15),
    chat(ids.older, "Older plan", 40),
  ];
  const run = vi.fn<Run>(async (_action, id, _signal, active) => {
    // A message arrives while this chat's archive is being prepared.
    if (id === ids.older) channels[1] = chat(ids.older, "Older plan", 0);
    if (active?.() === false)
      throw new DOMException("Channel action cancelled", "AbortError");
  });
  const { user, store } = await mount(channels, [ids.old, ids.older], [], run);
  await user.click(screen.getByRole("button", { name: "Archive 2 chats" }));
  expect(await screen.findByText("Archived 1 chat")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Restored 1 chat")).toBeVisible();
  expect(run.mock.calls.at(-1)?.slice(0, 2)).toEqual(["unarchive", ids.old]);
  store.dispose();
});

it("says so when nothing in the workspace is inactive", async () => {
  const run = vi.fn<Run>(async () => {});
  const { user, store, dialog } = await mount(
    [chat(ids.recent, "Recent plan", 2)],
    [ids.recent],
    [],
    run,
  );
  expect(dialog).toHaveTextContent(
    "No chats have been inactive for the last 14 days.",
  );
  await user.click(
    within(dialog)
      .getAllByRole("button", { name: "Close" })
      .at(-1) as HTMLElement,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(run).not.toHaveBeenCalled();
  store.dispose();
});
