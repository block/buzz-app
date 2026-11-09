// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarPreferences,
} from "../relay/sidebar-preferences";
import { WorkspaceControl } from "./WorkspaceControl";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture(sectionCreationWritable = true) {
  const assign = vi.fn(async (_channelId: string, _sectionId?: string) => {});
  const createSection = vi.fn(
    async (_section: { id: string; name: string }) => {},
  );
  const snapshot = {
    status: "ready" as const,
    data: {
      sections: [{ id: "buzz", name: "Buzz App", order: 0 }],
      assignments: { chat: "buzz" },
      starred: [],
      muted: [],
    },
  };
  const session = {
    soloPreferences: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      assign,
      refresh: vi.fn(async () => {}),
      sectionCreationWritable,
      createSection,
    },
  } as unknown as RelaySession;
  return { session, assign, createSection };
}

it("moves a saved chat without changing project defaults", async () => {
  const { session, assign } = fixture();
  // A move waits on the relay, and the control stays busy until it ends.
  let moved!: () => void;
  assign.mockReturnValue(new Promise<void>((resolve) => (moved = resolve)));
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  const control = screen.getByRole("button", { name: "Workspace: Buzz App" });
  await user.click(control);
  await user.click(
    await screen.findByRole("menuitemradio", { name: "No workspace" }),
  );
  expect(assign).toHaveBeenCalledWith("chat", undefined);
  // The menu hands focus back as the move starts. jsdom focuses a natively
  // disabled button; a browser can't.
  await waitFor(() => expect(control).toHaveFocus());
  expect(control).not.toHaveAttribute("disabled");
  expect(control).toHaveAttribute("aria-disabled", "true");
  await act(async () => moved());
  expect(control).not.toHaveAttribute("aria-disabled");
});

it("changes a new-chat project locally instead of moving a saved channel", async () => {
  const { session, assign } = fixture();
  const change = vi.fn();
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} value="" onChange={change} />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Buzz App" }),
  );
  expect(change).toHaveBeenCalledWith("buzz");
  expect(assign).not.toHaveBeenCalled();
});

it("keeps project recovery reachable after preferences fail", async () => {
  const refresh = vi.fn(async () => {});
  const session = {
    soloPreferences: {
      snapshot: () => ({ status: "error", error: "Projects unavailable" }),
      subscribe: () => () => {},
      assign: vi.fn(async () => {}),
      refresh,
    },
  } as unknown as RelaySession;
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Retry workspaces" }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it("shows a region chat's workspace and files it through its region", async () => {
  const h = createSoloRegionFixture();
  try {
    const { session, assign } = fixture();
    Object.assign(h.session, { soloPreferences: session.soloPreferences });
    let id: string | undefined = "buzz";
    let revision = 1;
    const region = await h.register({
      workspace: (_binding, channelId) =>
        channelId === "owned"
          ? {
              ...(id ? { id } : {}),
              file: async (next) => {
                id = next;
                region.update({
                  status: "ready",
                  binding: region.binding(),
                  revision: ++revision,
                });
              },
            }
          : undefined,
    });
    const user = userEvent.setup();
    const relay = h.session as unknown as RelaySession;
    render(<WorkspaceControl session={relay} channelId="owned" />);
    await user.click(
      await screen.findByRole("button", { name: "Workspace: Buzz App" }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "No workspace" }),
    );
    expect(
      await screen.findByRole("button", { name: "Add workspace" }),
    ).toBeVisible();
    expect(id).toBeUndefined();
    expect(assign).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

it("keeps focus on the control while a keyboard choice saves, and ignores it until then", async () => {
  const h = createSoloRegionFixture();
  let finish = () => {};
  try {
    const { session } = fixture();
    Object.assign(h.session, { soloPreferences: session.soloPreferences });
    const file = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await h.register({
      workspace: (_binding, channelId) =>
        channelId === "owned" ? { id: "buzz", file } : undefined,
    });
    const user = userEvent.setup();
    const relay = h.session as unknown as RelaySession;
    render(<WorkspaceControl session={relay} channelId="owned" />);
    const control = await screen.findByRole("button", {
      name: "Workspace: Buzz App",
    });
    control.focus();
    await user.keyboard("{Enter}");
    (
      await screen.findByRole("menuitemradio", { name: "No workspace" })
    ).focus();
    await user.keyboard("{Enter}");
    expect(file).toHaveBeenCalledExactlyOnceWith(undefined);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // A browser moves focus off a disabled button; jsdom keeps it there.
    expect(control).toBeEnabled();
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    await act(async () => finish());
    await waitFor(() => expect(control).not.toHaveAttribute("aria-disabled"));
    expect(control).toHaveFocus();
    expect(file).toHaveBeenCalledOnce();
  } finally {
    finish();
    await h.dispose();
  }
});

it("keeps hiding a region chat whose region offers no workspace", async () => {
  const h = createSoloRegionFixture();
  try {
    const { session } = fixture();
    Object.assign(h.session, { soloPreferences: session.soloPreferences });
    await h.register();
    const relay = h.session as unknown as RelaySession;
    const view = render(<WorkspaceControl session={relay} channelId="owned" />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<WorkspaceControl session={relay} channelId="chat" />);
    expect(
      screen.getByRole("button", { name: "Workspace: Buzz App" }),
    ).toBeVisible();
  } finally {
    await h.dispose();
  }
});

/** A real Solo preferences store over one groups record, so a test can count
 * its writes. Reads wait while `hold` is pending. */
async function storeFixture() {
  let saved: SidebarPreferences = {
    sections: [{ id: "buzz", name: "Buzz App", order: 0 }],
    assignments: { chat: "buzz" },
    starred: [],
    muted: [],
  };
  const reads = { hold: Promise.resolve() };
  const write = vi.fn(async (intent: SidebarAssignmentIntent) => {
    const created = intent.createSection;
    if (created)
      saved = {
        ...saved,
        sections: [...saved.sections, { ...created, order: 1 }],
      };
    const target = created?.id ?? intent.sectionId;
    const assignments = { ...saved.assignments };
    if (intent.channelId !== undefined) {
      if (target) assignments[intent.channelId] = target;
      else delete assignments[intent.channelId];
    }
    saved = { ...saved, assignments };
    return saved;
  });
  const store = createSidebarPreferencesStore({
    read: async () => {
      await reads.hold;
      return saved;
    },
    available: true,
    groupsOnly: true,
    write,
  });
  await store.queries.ensure();
  const assign = vi.fn(store.queries.assign);
  const save = vi.fn(async () => {});
  const session = {
    scope: "https://relay.example.test:viewer",
    // Workspace defaults, which New workspace saves for folders.
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries: [] }),
      save,
    },
    soloPreferences: Object.create(store.queries, {
      assign: { value: assign },
    }),
  } as unknown as RelaySession;
  return { session, write, assign, save, reads };
}

it.each(
  [
    { chat: "a new chat", trigger: "Add workspace", channelId: undefined },
    { chat: "a saved chat", trigger: "Workspace: Buzz App", channelId: "chat" },
  ].flatMap((chat) => [
    { ...chat, submit: "Create" },
    { ...chat, submit: "Enter" },
  ]),
)(
  "creates a workspace from the composer and picks it for $chat in one write ($submit)",
  async ({ trigger, channelId, submit }) => {
    vi.stubGlobal("crypto", webcrypto);
    const { session, write, assign } = await storeFixture();
    const change = vi.fn();
    // The control sits in the composer's form; the dialog's submit is its own.
    const composerSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={composerSubmit}>
        {channelId ? (
          <WorkspaceControl session={session} channelId={channelId} />
        ) : (
          <WorkspaceControl session={session} value="" onChange={change} />
        )}
      </form>,
    );
    const control = screen.getByRole("button", { name: trigger });
    if (channelId) {
      // An earlier move failed, and its alert sits by the control.
      write.mockRejectedValueOnce(new Error("Offline"));
      await user.click(control);
      await user.click(
        await screen.findByRole("menuitemradio", { name: "No workspace" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
      write.mockClear();
      assign.mockClear();
    }
    await user.click(control);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "Planning");
    // A browser's Enter submits through the form-associated Create button;
    // jsdom has no implicit submission for it, so send that submit directly.
    if (submit === "Enter") fireEvent.submit(name.closest("form") as Element);
    else
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(control).toHaveFocus());
    expect(control).not.toHaveAttribute("disabled");
    expect(composerSubmit).not.toHaveBeenCalled();
    // A second write of the groups record within a second is refused, so the
    // workspace and a saved chat's move into it are one write.
    expect(write).toHaveBeenCalledOnce();
    const id = write.mock.calls[0]?.[0].createSection?.id;
    expect(write).toHaveBeenCalledWith(
      {
        ...(channelId ? { channelId } : {}),
        createSection: { id: expect.any(String), name: "Planning" },
      },
      expect.anything(),
    );
    expect(assign).not.toHaveBeenCalled();
    if (channelId) {
      expect(change).not.toHaveBeenCalled();
      expect(control).toHaveAccessibleName("Workspace: Planning");
      // The chat moved, so the earlier failure no longer applies.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } else expect(change).toHaveBeenCalledWith(id);
  },
);

it("leaves a saved chat's failed Create to New workspace's Retry", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { session, write, save } = await storeFixture();
  write.mockRejectedValueOnce(new Error("Offline"));
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  const control = screen.getByRole("button", { name: "Workspace: Buzz App" });
  await user.click(control);
  await user.click(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "New workspace" });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: /^Folders/ }),
    "~/repo",
  );
  await user.click(within(dialog).getByRole("button", { name: "Add" }));
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Offline");
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
    "Planning",
  );
  expect(within(dialog).getByText("~/repo")).toBeInTheDocument();
  // The store keeps no failed move, so the sidebar offers no Retry move that
  // would replay the move without the folders.
  expect(session.soloPreferences.snapshot().moves).toBeUndefined();
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  expect(save).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]?.[0]).toEqual(write.mock.calls[0]?.[0]);
  expect(save).toHaveBeenCalledOnce();
  expect(control).toHaveAccessibleName("Workspace: Planning");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps focus on the control while workspaces reload after Create", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { session, reads } = await storeFixture();
  let release!: () => void;
  // New chat reloads workspaces for the new pick, as SoloDraft's preload does.
  const change = vi.fn(() => {
    reads.hold = new Promise<void>((resolve) => (release = resolve));
    void session.soloPreferences.refresh();
  });
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} value="" onChange={change} />);
  const control = screen.getByRole("button", { name: "Add workspace" });
  await user.click(control);
  await user.click(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "New workspace" });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(session.soloPreferences.snapshot().status).toBe("loading");
  await waitFor(() => expect(control).toHaveFocus());
  // jsdom focuses a natively disabled button; a browser can't.
  expect(control).not.toHaveAttribute("disabled");
  expect(control).toHaveAttribute("aria-disabled", "true");
  // It still can't open while workspaces load.
  await user.keyboard("{Enter}");
  await user.keyboard("{ArrowDown}");
  await user.click(control);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await act(async () => release());
  expect(control).not.toHaveAttribute("aria-disabled");
  expect(control).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("menu", { name: "Choose workspace" }),
  ).toBeInTheDocument();
});

it("offers New workspace disabled while workspaces can't be created", async () => {
  const { session } = fixture(false);
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} value="" onChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
});
