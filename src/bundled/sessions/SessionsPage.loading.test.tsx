// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
type KitSnapshot = ReturnType<
  ReturnType<typeof createRelaySession>["session"]["mePlacement"]["snapshot"]
>;
import type { RelayData } from "../../features/relay/service";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { writeView } from "../../shared/view-state";
import { meTarget } from "../me/routes";
import {
  beginSessionShare,
  finishSessionShare,
} from "../../features/sessions/share-attempt";
import { MeSidebar } from "../me/MeSidebar";
import { SessionsPage } from "./SessionsPage";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});
const id = "11111111-1111-4111-8111-111111111111";
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function fixture(
  status: KitSnapshot["status"] = "ready",
  retained = true,
  type: "session" | "stream" = "session",
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: keypair().pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const scope = `https://test.example:${viewer.pubkey}`;
  let state: KitSnapshot = {
    ...owner.session.mePlacement.snapshot(),
    status,
    entries: [],
  };
  const listeners = new Set<() => void>();
  const channel = {
    id,
    name: "Planning",
    channelType: type,
    private: true as const,
    members: [viewer.pubkey],
  };
  const list = {
    status: retained ? ("ready" as const) : ("loading" as const),
    channels: retained ? [channel] : [],
  };
  const window = {
    ...owner.session.channels.window(id),
    status: "ready" as const,
    rows: [],
  };
  const set = vi.fn(async () => {});
  const refresh = vi.fn(async () => {});
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
      refreshRoster: vi.fn(async () => true),
      window: () => window,
      ensure() {},
    },
    channelDetails: {
      ...owner.session.channelDetails,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        version: "test",
        name: "Planning",
        description: "",
        visibility: "private" as const,
        canEdit: true,
      })),
    },
    mePlacement: {
      ...owner.session.mePlacement,
      available: true,
      snapshot: () => state,
      ensure() {},
      refresh,
      set,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, scope, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const abort = new AbortController();
  const navigation: PageNavigation = {
    entryId: "visit",
    target: meTarget(scope, id),
    signal: abort.signal,
    forSession: () => navigation,
    complete: () => true,
    resolve: () => true,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    open,
    snapshot: () => ({ attempt: { signal: abort.signal } }),
  } as unknown as Navigation;
  const mount = (withSidebar = false) =>
    render(
      <>
        {withSidebar && (
          <MeSidebar
            relay={relay}
            navigator={navigator}
            target={navigation.target}
          />
        )}
        <SessionsPage
          relay={relay}
          panels={{ ...contribution, register() {}, resolve: () => undefined }}
          extensions={extensions}
          navigation={navigation}
          navigator={navigator}
        />
      </>,
    );
  return {
    mount,
    abort,
    set,
    refresh,
    open,
    scope,
    session,
    update(next: KitSnapshot) {
      state = next;
      for (const listener of listeners) listener();
    },
    state,
  };
}
it.each([false, true])(
  "keeps retained transcript available while Me placement loads (retained=%s)",
  (retained) => {
    const f = fixture("loading", retained);
    f.mount();
    expect(screen.getByText("Loading Me placement…")).toBeVisible();
    if (retained) {
      expect(screen.getByLabelText("Channel message history")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
    } else
      expect(screen.queryByLabelText("Channel message history")).toBeNull();
  },
);
it("keeps failed placement read-only and restores sending after confirmed preferences", async () => {
  const f = fixture("loading");
  writeView(f.scope, `draft:${id}`, "Saved thought");
  f.mount(true);
  act(() =>
    f.update({ ...f.state, status: "error", error: "Preferences offline" }),
  );
  for (const notice of screen.getAllByText("Preferences offline"))
    expect(notice).toBeVisible();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry Me" }));
  expect(f.refresh).toHaveBeenCalledOnce();
  act(() => f.update({ ...f.state, status: "ready" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Saved thought");
});
it.each([false, true])(
  "does not reopen a stale visit after unified Share settles (failure=%s)",
  async (failure) => {
    const f = fixture();
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const held = { promise, resolve, reject };
    f.session.channels.refreshRoster.mockImplementation(async () => {
      await held.promise;
      return true;
    });
    try {
      f.mount();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Share" }));
      const dialog = screen.getByRole("dialog", { name: "Share session" });
      await waitFor(() =>
        expect(f.session.channels.refreshRoster).toHaveBeenCalledOnce(),
      );
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Loading current access",
      );
      f.abort.abort();
      await act(async () => {
        if (failure) held.reject(new Error("Late failure"));
        else held.resolve();
        await held.promise.catch(() => {});
      });
      expect(f.open).not.toHaveBeenCalled();
      expect(f.set).not.toHaveBeenCalled();
      expect(f.session.channelDetails.load).not.toHaveBeenCalled();
      expect(screen.queryByText("Late failure")).toBeNull();
    } finally {
      held.resolve();
    }
  },
);
it("opens a pending Me start through its original receipt after its section was deleted", () => {
  const f = fixture();
  writeView(f.scope, "me:section:deleted:pending", {
    id,
    text: "Recover",
    creationId: "c".repeat(64),
    setup: { sectionId: "deleted", canvas: "Frozen instructions", agents: [] },
  });
  f.mount();
  expect(screen.getByRole("region", { name: "New chat" })).toBeVisible();
  expect(screen.queryByLabelText("Channel message history")).toBeNull();
});

it("preserves the Session actions menu trigger relationship and keyboard focus", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Session actions" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  const menu = await screen.findByRole("menu", { name: "Session actions" });
  expect(trigger.id).not.toBe("");
  await waitFor(() =>
    expect(menu).toHaveAttribute("aria-labelledby", trigger.id),
  );
  await waitFor(() =>
    expect(
      within(menu).getByRole("menuitem", { name: "Convert to channel" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());

  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Convert to channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Convert to channel",
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(f.set).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("opens an already-moved Me route in Messages without a placement or settings write", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open in Messages" }));
  expect(f.open).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: "conversation", channelId: id }),
  );
  expect(f.set).not.toHaveBeenCalled();
  expect(f.session.channelDetails.load).not.toHaveBeenCalled();
});

it("updates the header conversion guard when a share starts and finishes elsewhere", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  const convert = await screen.findByRole("menuitem", {
    name: "Convert to channel",
  });
  expect(convert).not.toHaveAttribute("aria-disabled", "true");
  act(() => {
    beginSessionShare(f.session, id, {
      destination: id,
      audience: "selected",
      channelPeople: [],
      sessionPeople: [],
    });
  });
  expect(convert).toHaveAttribute("aria-disabled", "true");
  await user.click(convert);
  expect(
    screen.queryByRole("dialog", { name: "Convert to channel" }),
  ).toBeNull();
  act(() => {
    finishSessionShare(f.session, id);
  });
  expect(convert).not.toHaveAttribute("aria-disabled", "true");
  await user.click(convert);
  expect(
    await screen.findByRole("dialog", { name: "Convert to channel" }),
  ).toBeVisible();
});

it.each([false, true])(
  "a stale Me route uses ordinary controls after conversion despite retained placement=%s",
  (retained) => {
    const f = fixture("ready", true, "stream");
    if (retained)
      f.update({
        ...f.state,
        entries: [
          {
            eventId: "e".repeat(64),
            createdAt: 1,
            record: {
              version: 1,
              community: "https://test.example",
              deleted: false,
              value: {
                type: "groups",
                id: "me",
                groups: [],
                assignments: {},
                channels: [id],
              },
            },
          },
        ],
      });
    writeView(f.scope, `me:assistant:${id}`, "a".repeat(64));
    f.mount();
    expect(
      screen.queryByRole("textbox", { name: "Message your agents" }),
    ).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Message #Planning" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Choose follow-up assistant" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Project:/ })).toBeNull();
    if (!retained)
      expect(
        screen.getByText("This conversation is in Messages."),
      ).toBeVisible();
  },
);
