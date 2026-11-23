// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import { useContext, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSection } from "./SidebarSection";
import { SidebarCardDisplayContext } from "./SidebarCardDisplay";
import { MenuItem } from "../../shared/design-system/ui/Menu";
afterEach(cleanup);

it("offers only Sort in the card's menu, with Unreads first enabled", async () => {
  const user = userEvent.setup();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      heightScope="view-options-menu-test"
      sort={{ value: "alpha", change: () => {} }}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  const menu = await screen.findByRole("menu", {
    name: "More actions for Channels",
  });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Sort"]);
  await user.click(within(menu).getByRole("menuitem", { name: "Sort" }));
  const sort = await screen.findByRole("menu", { name: "Sort Channels" });
  const first = within(sort).getByRole("menuitemcheckbox", {
    name: "Unreads first",
  });
  expect(first).not.toHaveAttribute("aria-disabled", "true");
});

it.each([true, false])(
  "keeps Starred creation independent of collapse and respects availability (%s)",
  async (available) => {
    const user = userEvent.setup();
    const open = vi.fn();
    const toggle = vi.fn();
    render(
      <SidebarSection
        sectionKey="starred"
        title="Favorites"
        open={false}
        onToggle={toggle}
        createChannel={{ available, open }}
      >
        <button type="button">General</button>
      </SidebarSection>,
    );
    const trigger = screen.getByRole("button", { name: "New message" });
    if (available) {
      trigger.focus();
      await user.keyboard("{Enter}");
      expect(open).toHaveBeenCalledExactlyOnceWith(trigger);
    } else {
      expect(trigger).toBeDisabled();
      await user.click(trigger);
      expect(open).not.toHaveBeenCalled();
    }
    expect(toggle).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Favorites").closest("details"),
    ).not.toHaveAttribute("open");
  },
);

function Section({
  sort,
}: {
  sort?: {
    value: import("../../features/relay/sidebar-sort").SidebarSortMode;
    change: (
      value: import("../../features/relay/sidebar-sort").SidebarSortMode,
    ) => void;
  };
} = {}) {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <SidebarSection
        sectionKey="channels"
        title="Channels"
        open={open}
        onToggle={setOpen}
        newMessage={() => {}}
        sort={sort}
      >
        <button type="button">General</button>
      </SidebarSection>
      <button type="button" onClick={() => setRevision(revision + 1)}>
        Update {revision}
      </button>
    </>
  );
}
it("keeps section actions independent of disclosure and supports menu keyboard dismissal", async () => {
  const user = userEvent.setup();
  render(<Section sort={{ value: "alpha", change: vi.fn() }} />);
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
  const trigger = screen.getByRole("button", {
    name: "More actions for Channels",
  });
  await user.click(screen.getByLabelText("Channels"));
  expect(
    screen.getByLabelText("Channels").closest("details"),
  ).not.toHaveAttribute("open");
  const section = trigger.closest("[data-sidebar-section]");
  expect(section).not.toHaveAttribute("data-menu-open");
  await user.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  expect(
    screen.queryByRole("menuitem", { name: "Expand section" }),
  ).not.toBeInTheDocument();
  expect(section).toHaveAttribute("data-menu-open");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(section).not.toHaveAttribute("data-menu-open");
  expect(trigger).toHaveFocus();
  await user.click(screen.getByLabelText("Channels"));
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});
it("sorts from the card's Sort submenu and turns unreads first off", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      heightScope="unreads-first-test"
      sort={{ value: "alpha", change }}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Sort" }));
  const sort = await screen.findByRole("menu", { name: "Sort Channels" });
  expect(
    within(sort).getByRole("menuitemradio", { name: "A–Z" }),
  ).toBeChecked();
  // The open submenu ignores pointer input until the pointer moves into it.
  fireEvent.click(within(sort).getByRole("menuitemradio", { name: "Recent" }));
  expect(change).toHaveBeenCalledExactlyOnceWith("recent");
  const first = within(sort).getByRole("menuitemcheckbox", {
    name: "Unreads first",
  });
  expect(first).toBeChecked();
  fireEvent.click(first);
  expect(first).not.toBeChecked();
});

it("filters from the card's Filter submenu and applies a custom window", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const card = (days: number | undefined) => (
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      filter={{ days, change }}
    >
      <p>Rows</p>
    </SidebarSection>
  );
  const { rerender } = render(card(undefined));
  const openFilter = async () => {
    await user.click(
      screen.getByRole("button", { name: "More actions for Channels" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
    return screen.findByRole("menu", { name: "Filter Channels" });
  };
  let filter = await openFilter();
  expect(
    within(filter)
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent),
  ).toEqual(["All", "1 day", "3 days", "7 days", "30 days", "Custom…"]);
  expect(
    within(filter).getByRole("menuitemradio", { name: "All" }),
  ).toBeChecked();
  // The open submenu ignores pointer input until the pointer moves into it.
  fireEvent.click(
    within(filter).getByRole("menuitemradio", { name: "7 days" }),
  );
  expect(change).toHaveBeenLastCalledWith(7);
  fireEvent.click(
    within(filter).getByRole("menuitemradio", { name: "Custom…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Active in the last",
  });
  const days = within(dialog).getByRole("spinbutton", { name: "Days" });
  await user.clear(days);
  await user.type(days, "14");
  await user.click(within(dialog).getByRole("button", { name: "Apply" }));
  expect(change).toHaveBeenLastCalledWith(14);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // A saved window that is not a preset shows as the custom choice.
  rerender(card(14));
  filter = await openFilter();
  expect(
    within(filter).getByRole("menuitemradio", { name: "Custom (14 days)" }),
  ).toBeChecked();
  await user.keyboard("{Escape}{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  rerender(card(30));
  filter = await openFilter();
  expect(
    within(filter).getByRole("menuitemradio", { name: "30 days" }),
  ).toBeChecked();
  expect(
    within(filter).getByRole("menuitemradio", { name: "Custom…" }),
  ).not.toBeChecked();
});

it("opens Custom from the keyboard and keeps a failed save's error in the dialog", async () => {
  const user = userEvent.setup();
  const change = vi.fn().mockRejectedValue(new Error("Relay offline"));
  const dismissError = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      filter={{ days: undefined, change, dismissError }}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
  const filter = await screen.findByRole("menu", { name: "Filter Channels" });
  within(filter).getByRole("menuitemradio", { name: "Custom…" }).focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Active in the last",
  });
  await user.click(within(dialog).getByRole("button", { name: "Apply" }));
  expect(await within(dialog).findByText("Relay offline")).toBeVisible();
  expect(dismissError).toHaveBeenCalledOnce();
});

it("orders header actions before section rows for keyboard navigation", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  summary.focus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "More actions for Channels" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "New message" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
});
it("retains an expansion requested by an offscreen unread cue on subsequent renders", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  await user.click(summary);
  const details = summary.closest("details");
  if (!details) throw new Error("Missing section disclosure");
  fireEvent.click(summary);
  await user.click(screen.getByRole("button", { name: "Update 0" }));
  expect(details).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});

it("offers confirmed removal for custom sections", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRemove={remove}
      channelCount={1}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove workspace" }),
  );
  const confirmation = screen.getByRole("dialog", { name: "Remove Work?" });
  expect(confirmation).toHaveAccessibleDescription(
    "1 conversation will return to their default sections.",
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove workspace" }),
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "Remove Work?" })).getByRole(
      "button",
      { name: "Remove workspace" },
    ),
  );
  expect(remove).toHaveBeenCalledOnce();
});

it("holds confirmation while removing, shows failure, and permits explicit retry", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  const remove = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(undefined);
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRemove={remove}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove workspace" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
  try {
    await user.click(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "waiting for confirmation",
    );
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
  } finally {
    reject(new Error("Publication not confirmed"));
  }
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Publication not confirmed",
  );
  // The modal deliberately makes the retained sidebar aria-hidden.
  expect(screen.getByText("General", { exact: true })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove workspace" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(remove).toHaveBeenCalledTimes(2);
});
it.each(["Cancel", "Escape"])(
  "restores section focus after failure then %s",
  async (dismiss) => {
    const user = userEvent.setup();
    const remove = vi
      .fn()
      .mockRejectedValue(new Error("Publication not confirmed"));
    render(
      <SidebarSection
        sectionKey="group:work"
        title="Work"
        open
        onToggle={() => {}}
        onRemove={remove}
      >
        <button type="button">General</button>
      </SidebarSection>,
    );
    const trigger = screen.getByRole("button", {
      name: "More actions for Work",
    });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove workspace" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Publication not confirmed",
    );
    if (dismiss === "Cancel")
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    else await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(remove).toHaveBeenCalledOnce();
  },
);

it("never offers removal for built-in sections even when a callback is supplied", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      onRemove={remove}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menu", { name: "More actions for Channels" });
  expect(
    screen.queryByRole("menuitem", { name: "Remove workspace" }),
  ).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it.each([0, 2])(
  "describes %s channels in removal confirmation",
  async (count) => {
    const user = userEvent.setup();
    render(
      <SidebarSection
        sectionKey="group:work"
        title="Work"
        open
        onToggle={() => {}}
        onRemove={() => {}}
        channelCount={count}
      >
        <span>Rows</span>
      </SidebarSection>,
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove workspace" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Remove Work?" }),
    ).toHaveAccessibleDescription(
      `${count} conversations will return to their default sections.`,
    );
  },
);

it("offers Move up and Move down for reorderable groups, disabled at each end", async () => {
  const user = userEvent.setup();
  const down = vi.fn();
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      move={{ down }}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  const trigger = screen.getByRole("button", { name: "More actions for Work" });
  await user.click(trigger);
  expect(
    await screen.findByRole("menuitem", { name: "Move up" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("menuitem", { name: "Move down" }));
  expect(down).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("never offers moves without a move capability", async () => {
  const user = userEvent.setup();
  render(<Section />);
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menu", { name: "More actions for Channels" });
  expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Move down" })).toBeNull();
});

it("opens workspace settings from a saved section's menu", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      menuActions={(dismiss) => (
        <MenuItem
          onClick={() => {
            dismiss();
            open();
          }}
        >
          Workspace settings
        </MenuItem>
      )}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Workspace settings" }),
  );
  expect(open).toHaveBeenCalledOnce();
});

it("keeps the actions menu closed after it is hidden and shown again", async () => {
  const user = userEvent.setup();
  const section = (hideMoreActions: boolean) => (
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={vi.fn()}
      hideMoreActions={hideMoreActions}
    >
      <p>Rows</p>
    </SidebarSection>
  );
  const { rerender } = render(section(false));
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menu", { name: "More actions for Channels" });
  rerender(section(true));
  expect(
    screen.queryByRole("button", { name: "More actions for Channels" }),
  ).toBeNull();
  rerender(section(false));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("hides a card's own actions but keeps its view choices when it hides more actions", async () => {
  const user = userEvent.setup();
  const card = (sort?: { value: "recent"; change: () => void }) => (
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={vi.fn()}
      hideMoreActions
      move={{ down: vi.fn() }}
      menuActions={() => <MenuItem>Workspace settings</MenuItem>}
      sort={sort}
    >
      <p>Rows</p>
    </SidebarSection>
  );
  const { rerender } = render(card({ value: "recent", change: vi.fn() }));
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  const menu = await screen.findByRole("menu", {
    name: "More actions for Work",
  });
  // Only view choices: no Move, settings or removal, nor a divider before them.
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Sort"]);
  expect(within(menu).queryByRole("separator")).toBeNull();
  await user.keyboard("{Escape}");
  // With no view choices at all, the menu has nothing to hold and is hidden.
  rerender(card());
  expect(
    screen.queryByRole("button", { name: "More actions for Work" }),
  ).toBeNull();
});

function RenamableSection({
  save,
  toggle,
  title: remoteTitle,
  stopped,
}: {
  /** How the edit ended: with focus still its own, or not. */
  stopped?(focus: boolean): void;
  save(name: string, openedWith: string): Promise<unknown>;
  toggle(open: boolean): void;
  /** A name the workspace took elsewhere, such as on another device. */
  title?: string;
}) {
  const [localTitle, setTitle] = useState("Untitled workspace");
  const title = remoteTitle ?? localTitle;
  const [editing, setEditing] = useState(false);
  return (
    <SidebarSection
      sectionKey="group:new"
      title={title}
      open
      onToggle={toggle}
      rename={{
        editing,
        start: () => setEditing(true),
        save: async (name, openedWith) => {
          await save(name, openedWith);
          setTitle(name);
        },
        stop: (focus) => {
          stopped?.(focus);
          setEditing(false);
        },
      }}
    >
      <button type="button">General</button>
    </SidebarSection>
  );
}

it("renames a workspace in place on double-click without toggling it", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  const toggle = vi.fn();
  render(<RenamableSection save={save} toggle={toggle} />);
  await user.dblClick(screen.getByLabelText("Untitled workspace"));
  const input = screen.getByRole("textbox", { name: "Workspace name" });
  expect(input).toHaveFocus();
  await user.keyboard("Design{Enter}");
  expect(save).toHaveBeenCalledExactlyOnceWith("Design", "Untitled workspace");
  expect(await screen.findByLabelText("Design")).toBeInTheDocument();
  await new Promise((done) => setTimeout(done, 300));
  expect(toggle).not.toHaveBeenCalled();
});

it("cancels a rename on Escape or an unchanged name", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(<RenamableSection save={save} toggle={vi.fn()} />);
  await user.dblClick(screen.getByLabelText("Untitled workspace"));
  await user.keyboard("Design{Escape}");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await user.dblClick(screen.getByLabelText("Untitled workspace"));
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it("keeps the name open with the reason when saving fails", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {
    throw new Error("Sidebar edits are not available offline.");
  });
  render(<RenamableSection save={save} toggle={vi.fn()} />);
  await user.dblClick(screen.getByLabelText("Untitled workspace"));
  await user.keyboard("Design{Enter}");
  expect(
    await screen.findByText("Sidebar edits are not available offline."),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    "Design",
  );
});

it("toggles a renamable workspace on a single click after a beat, and at once from the keyboard", async () => {
  const user = userEvent.setup();
  const toggle = vi.fn();
  render(<RenamableSection save={vi.fn()} toggle={toggle} />);
  const summary = screen.getByLabelText("Untitled workspace");
  await user.click(summary);
  expect(toggle).not.toHaveBeenCalled();
  await waitFor(() => expect(toggle).toHaveBeenCalledExactlyOnceWith(false));
  // Keyboard activation is a click with no click count.
  fireEvent.click(summary, { detail: 0 });
  expect(toggle).toHaveBeenCalledTimes(2);
});

it("compares a rename with the name it opened with, not a newer one from elsewhere", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  const { rerender } = render(
    <RenamableSection save={save} toggle={vi.fn()} title="Work" />,
  );
  await user.dblClick(screen.getByLabelText("Work"));
  // Another device renames it while this editor is open and untouched.
  rerender(<RenamableSection save={save} toggle={vi.fn()} title="Research" />);
  await user.keyboard("{Enter}");
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  // An edit is checked against the name it started from.
  await user.dblClick(screen.getByLabelText("Research"));
  await user.keyboard("Design{Enter}");
  expect(save).toHaveBeenCalledExactlyOnceWith("Design", "Research");
});

it("returns focus to the header after a save that loses it, but not after a deliberate move", async () => {
  const user = userEvent.setup();
  const stopped = vi.fn();
  let release = () => {};
  const save = vi.fn(
    () => new Promise<void>((done) => (release = () => done())),
  );
  render(
    <>
      <RenamableSection save={save} toggle={vi.fn()} stopped={stopped} />
      <button type="button">Elsewhere</button>
    </>,
  );
  await user.dblClick(screen.getByLabelText("Untitled workspace"));
  await user.keyboard("Design{Enter}");
  // The sidebar re-renders while saving and the input loses focus.
  act(() => (document.activeElement as HTMLElement).blur());
  await act(async () => release());
  expect(stopped).toHaveBeenLastCalledWith(true);
  await user.dblClick(screen.getByLabelText("Design"));
  await user.keyboard("Research{Enter}");
  // Someone moves on to something else while it saves.
  act(() => screen.getByText("Elsewhere").focus());
  await act(async () => release());
  expect(stopped).toHaveBeenLastCalledWith(false);
});
it("switches a card between a list and icons from its ••• menu, remembered on this device", async () => {
  const user = userEvent.setup();
  function Rows() {
    return <p>Display: {useContext(SidebarCardDisplayContext)}</p>;
  }
  const card = () => (
    <SidebarSection
      sectionKey="dms"
      title="Direct messages"
      open
      onToggle={() => {}}
      heightScope="icon-view-test"
      iconView
    >
      <Rows />
    </SidebarSection>
  );
  const view = render(card());
  expect(screen.getByText("Display: list")).toBeInTheDocument();
  const rows = () => document.querySelector("[data-card-rows]");
  expect(rows()).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "More actions for Direct messages" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Icons" }));
  expect(screen.getByText("Display: icons")).toBeInTheDocument();
  // Icons keep the card's size and its resizable rows.
  expect(
    document.querySelector('[data-card-display="icons"] [data-card-rows]'),
  ).toBeInTheDocument();
  view.unmount();
  render(card());
  expect(screen.getByText("Display: icons")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "More actions for Direct messages" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "List" }));
  expect(screen.getByText("Display: list")).toBeInTheDocument();
});
it("offers no icon view to a card that keeps its names", async () => {
  const user = userEvent.setup();
  render(
    <SidebarSection
      sectionKey="solo"
      title="Solo chats"
      open
      onToggle={() => {}}
      heightScope="icon-view-test"
      newMessage={() => {}}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Solo chats" }),
  );
  const menu = await screen.findByRole("menu", {
    name: "More actions for Solo chats",
  });
  // Unreads first sits under Sort; Layout is offered only with an icon view.
  expect(
    within(menu).getByRole("menuitem", { name: "Sort" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitemradio", { name: "Icons" }),
  ).not.toBeInTheDocument();
});
