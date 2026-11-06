// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Role } from "../../features/communities/roster";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { readView } from "../../shared/view-state";
import type {
  CommunityMembership,
  MembershipSnapshot,
} from "../moderation/membership";
import { resetFirstChannelAttempts, useFirstChannel } from "./first-channel";

const scope = "wss://example.org:viewer";
const created = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  localStorage.clear();
  resetFirstChannelAttempts();
  ensure.mockClear();
});
afterEach(cleanup);

const ensure = vi.fn(() => () => {});
function membership(role: Role | undefined) {
  const snapshot: MembershipSnapshot = Object.freeze({
    status: "ready",
    members: [],
    ...(role ? { role } : {}),
    refreshing: false,
  });
  return {
    snapshot: () => snapshot,
    subscribe: () => () => true,
    ensure,
    refresh: async () => {},
    dispose: () => {},
  } satisfies CommunityMembership;
}

function session({
  open = [],
  partial = false,
  create = async () => created,
}: {
  open?: { id: string; name: string; archived?: true }[];
  partial?: boolean;
  create?: () => Promise<string>;
} = {}) {
  let directory: typeof open = [];
  const readDirectory = vi.fn(async () => {
    directory = open;
    return { partial };
  });
  const creation = vi.fn(create);
  const run = vi.fn(async () => {});
  const queries = {
    channels: { readDirectory, openDirectory: () => directory },
    channelCreation: { available: true, create: creation },
    channelLifecycle: { available: true, run },
  } as unknown as RelaySession;
  return { queries, readDirectory, creation, run };
}

const ready = (channels: ChannelSummary[] = []): ChannelList => ({
  status: "ready",
  channels,
});

function mount(
  queries: RelaySession,
  {
    role = "owner",
    list = ready(),
    cached = false,
  }: { role?: Role | null; list?: ChannelList; cached?: boolean } = {},
) {
  return renderHook(
    (props: { list: ChannelList }) =>
      useFirstChannel({
        scope,
        cached,
        queries,
        list: props.list,
        membership: membership(role ?? undefined),
      }),
    { initialProps: { list } },
  );
}

it("creates one open general for the owner of an empty community and flags it", async () => {
  const f = session();
  const view = mount(f.queries);
  await waitFor(() =>
    expect(f.run).toHaveBeenCalledWith("auto-join-on", created),
  );
  expect(f.creation).toHaveBeenCalledOnce();
  expect(f.creation).toHaveBeenCalledWith({
    name: "general",
    visibility: "open",
  });
  await waitFor(() =>
    expect(readView(scope, "first-channel", false)).toBe(true),
  );
  // A later mount, even in a new app run, does not create another.
  view.unmount();
  resetFirstChannelAttempts();
  mount(f.queries);
  expect(f.readDirectory).toHaveBeenCalledOnce();
  expect(f.creation).toHaveBeenCalledOnce();
});

it("leaves a community that already has an open channel, archived included", async () => {
  const f = session({
    open: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "old",
        archived: true,
      },
    ],
  });
  mount(f.queries);
  await waitFor(() =>
    expect(readView(scope, "first-channel", false)).toBe(true),
  );
  expect(f.creation).not.toHaveBeenCalled();
});

it("creates nothing from a partial directory read, and settles nothing", async () => {
  const f = session({ partial: true });
  mount(f.queries);
  await waitFor(() => expect(f.readDirectory).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(f.creation).not.toHaveBeenCalled();
  expect(readView(scope, "first-channel", false)).toBe(false);
});

it.each<Role | null>(["admin", "member", null])(
  "does nothing for a viewer whose role is %s",
  (role) => {
    const f = session();
    mount(f.queries, { role });
    expect(f.readDirectory).not.toHaveBeenCalled();
  },
);

it("does nothing while the owner has joined a channel, the list is loading or cached", () => {
  const f = session();
  mount(f.queries, {
    list: ready([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "ops",
        channelType: "stream",
      },
    ]),
  });
  mount(f.queries, { list: { status: "loading", channels: [] } });
  mount(f.queries, { cached: true });
  expect(f.readDirectory).not.toHaveBeenCalled();
  // Nor does it read the community roster for a viewer with a channel to open.
  expect(ensure).not.toHaveBeenCalled();
});

it("does not retry a refused create in the same run", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = session({
    create: () =>
      Promise.reject(
        new Error('an open channel named "general" already exists'),
      ),
  });
  const view = mount(f.queries);
  await waitFor(() => expect(warn).toHaveBeenCalled());
  view.rerender({ list: ready() });
  expect(f.creation).toHaveBeenCalledOnce();
  expect(readView(scope, "first-channel", false)).toBe(false);
  warn.mockRestore();
});
