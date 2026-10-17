// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { SoloSections } from "./SoloSections";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  cleanup();
  localStorage.clear();
});

function fixture(sectionName = "Work") {
  const owner = createRelaySession(null);
  owners.push(owner);
  let saved: SidebarPreferences = {
    sections: [{ id: "work", name: sectionName, order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  const write = vi.fn(
    async (intent: {
      channelId: string;
      sectionId?: string;
      createSection?: { id: string; name: string };
    }) => {
      if (intent.createSection)
        saved = {
          ...saved,
          sections: [...saved.sections, { ...intent.createSection, order: 1 }],
        };
      const assignments = { ...saved.assignments };
      const target = intent.createSection?.id ?? intent.sectionId;
      if (target) assignments[intent.channelId] = target;
      else delete assignments[intent.channelId];
      saved = { ...saved, assignments };
      return saved;
    },
  );
  const remove = vi.fn(async (id: string) => {
    saved = {
      ...saved,
      sections: saved.sections.filter((section) => section.id !== id),
      assignments: Object.fromEntries(
        Object.entries(saved.assignments).filter(
          ([, section]) => section !== id,
        ),
      ),
    };
    return saved;
  });
  const store = () =>
    createSidebarPreferencesStore(
      async () => saved,
      true,
      write,
      async () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      remove,
      true, // Groups-only sessions have no Messages sort coordinate.
    );
  const onNew = vi.fn();
  const channels = { status: "ready", channels: [] };
  const view = (
    preferences: ReturnType<typeof store>["queries"],
    scope = "viewer:community",
  ) => (
    <SoloSections
      onNew={onNew}
      session={
        {
          ...owner.session,
          soloPreferences: preferences,
          canvas: { available: false },
          channels: { list: () => channels, subscribeList: () => () => {} },
        } as unknown as RelaySession
      }
      scope={scope}
      sessions={[
        { id: "session", title: "Planning" },
        { id: "other", title: "Existing chat" },
      ]}
      renderSession={(item) => <button type="button">{item.title}</button>}
    />
  );
  return { store, view, write, remove, onNew, saved: () => saved };
}

it("creates and moves through the relay service, then restores in a fresh store", async () => {
  const h = fixture();
  const first = h.store();
  const user = userEvent.setup();
  const mounted = render(h.view(first.queries));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Chat settings…" }),
  ).toHaveAttribute("aria-disabled", "true");
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "New project…" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "Projects",
  );
  await user.click(screen.getByRole("button", { name: "Create and move" }));
  await waitFor(() =>
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "session",
        createSection: expect.objectContaining({ name: "Projects" }),
      }),
      expect.objectContaining({ aborted: false }),
    ),
  );
  await waitFor(() => expect(screen.queryByText("Saving project…")).toBeNull());
  expect(h.saved().assignments.session).toBe(h.saved().sections[1]?.id);
  mounted.unmount();
  first.dispose();
  const second = h.store();
  render(h.view(second.queries, "other-device"));
  const section = await screen.findByRole("button", { name: "Projects" });
  expect(section.parentElement?.parentElement).toHaveTextContent("Planning");
  fireEvent.click(section);
  expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
  expect(screen.getByRole("button", { name: "Existing chat" })).toBeVisible();
  second.dispose();
});

it("rolls back a rejected move and keeps retry available", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  h.write.mockRejectedValueOnce(new Error("Relay unavailable"));
  render(h.view(store.queries));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Relay unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Chats" }).parentElement?.parentElement,
  ).toHaveTextContent("Planning");
  await user.click(screen.getByRole("button", { name: "Retry move" }));
  await waitFor(() => expect(h.saved().assignments.session).toBe("work"));
  await waitFor(() =>
    expect(screen.queryByText("Relay unavailable")).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "Work" }).parentElement?.parentElement,
  ).toHaveTextContent("Planning");
  store.dispose();
});

it("keeps chats after project deletion and allows retry after a rejected deletion", async () => {
  const h = fixture();
  const owner = h.store();
  const user = userEvent.setup();
  await owner.queries.ensure();
  await owner.queries.assign("session", "work");
  render(h.view(owner.queries));
  h.remove.mockRejectedValueOnce(new Error("Deletion unavailable"));
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete project" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion unavailable",
  );
  expect(screen.getByRole("button", { name: "Work" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete project" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
  expect(h.saved().assignments).toEqual({});
  owner.dispose();
});

it("starts an unfiled chat from the Chats heading plus without collapsing it", async () => {
  const h = fixture();
  const owner = h.store();
  render(h.view(owner.queries));
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "New chat in Chats" }),
  );
  expect(h.onNew).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  owner.dispose();
});

it.each([
  ["Copy chat name", "Planning"],
  ["Copy chat ID", "session"],
  ["Copy link to session", "buzz://channel/session"],
])("copies the session value for %s", async (label, expected) => {
  const h = fixture();
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Copy" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: label }));
  expect(write).toHaveBeenCalledWith(expected);
});

it("reports a clipboard failure without claiming success", async () => {
  const h = fixture();
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Copy" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy chat ID" }),
  );
  expect(
    await screen.findByText("Couldn’t copy. Try again from the session menu."),
  ).toBeVisible();
});

it("only offers Chats as a destination from a project", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const store = h.store();
  render(h.view(store.queries));
  const openSectionMenu = async () => {
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    (await screen.findByRole("menuitem", { name: "Move to" })).focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("menuitem", { name: "New project…" });
  };
  await openSectionMenu();
  expect(screen.queryByRole("menuitem", { name: "Chats" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Work" }));
  await waitFor(() => expect(h.saved().assignments.session).toBe("work"));
  await openSectionMenu();
  await user.click(screen.getByRole("menuitem", { name: "Chats" }));
  await waitFor(() => expect(h.saved().assignments.session).toBeUndefined());
  store.dispose();
});

it("tabs through a project's overflow before its trailing new-chat action", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  render(h.view(store.queries));
  try {
    const heading = await screen.findByRole("button", { name: "Work" });
    heading.focus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Actions for Work" }),
    ).toHaveFocus();
    const header = heading.parentElement;
    if (!header) throw new Error("Missing section header");
    const newChat = within(header).getByRole("button", {
      name: "New chat in Work",
    });
    await user.tab();
    expect(newChat).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(h.onNew).toHaveBeenCalledExactlyOnceWith("work");
  } finally {
    store.dispose();
  }
});

it("keeps an empty project's New chat label short while naming and opening the exact project", async () => {
  const projectName =
    "A very long project name that should not become the new chat label";
  const h = fixture(projectName);
  const store = h.store();
  const user = userEvent.setup();
  render(h.view(store.queries, "empty-project"));
  try {
    const choices = await screen.findAllByRole("button", {
      name: `New chat in ${projectName}`,
    });
    const row = choices.find((choice) => choice.textContent === "New chat");
    expect(row).toBeDefined();
    if (!row) throw new Error("Missing empty project action");
    expect(row).toHaveAttribute("title", `New chat in ${projectName}`);
    row.focus();
    await user.keyboard("{Enter}");
    expect(h.onNew).toHaveBeenCalledExactlyOnceWith("work");
  } finally {
    store.dispose();
  }
});
