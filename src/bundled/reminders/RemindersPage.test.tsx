// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  type ReactNode,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import {
  createReminders,
  type Reminder,
  type Reminders,
} from "../../features/relay/reminders";
import type { RelayData } from "../../features/relay/service";
import {
  createNavigationController,
  type Navigation,
} from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { ReminderEditor } from "./RemindDialog";
import userEvent from "@testing-library/user-event";
import { RemindersPage } from "./RemindersPage";
import { apply } from "./index";
import { mediaUrl } from "../../features/relay/transport";

const controllers = new Set<ReturnType<typeof createNavigationController>>();
afterEach(() => {
  cleanup();
  for (const controller of controllers) controller.dispose();
  controllers.clear();
});

const viewer = "a".repeat(64);
const reminderPage = {
  version: 1,
  kind: "page",
  pluginId: "buzz.reminders",
  pageId: "reminders",
  scope: { communityOrigin: "https://community", viewer },
} as const;
function reminderNavigation() {
  const controller = createNavigationController(createMemoryHistory());
  controllers.add(controller);
  void controller.navigation.open(reminderPage);
  return controller.navigation;
}
function ReminderHost({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const { entry } = useSyncExternalStore(
    navigator.subscribe,
    navigator.snapshot,
  );
  return (
    <>
      {entry.target.kind === "page" && (
        <RemindersPage
          relay={relay}
          navigator={navigator}
          clock={{ subscribe: () => () => {}, read: () => now }}
        />
      )}
      <ReminderEditor relay={relay} navigator={navigator} />
    </>
  );
}
const now = 1_000_000;
const reminder = (
  id: string,
  status: Reminder["status"],
  createdAt: number,
  notBefore?: number,
): Reminder => ({
  id,
  eventId: `${id}-event`,
  createdAt,
  status,
  ...(notBefore !== undefined ? { notBefore } : {}),
  target: {
    eventId: `${id}-message`,
    channelId: "c",
    preview: id,
    authorPubkey: "a",
  },
});

/** The session reads the page makes beside reminders: channel names, author profiles. */
const channelList = {
  status: "ready",
  channels: [{ id: "c", name: "general", channelType: "stream" }],
};
const authorPicture = `https://community/media/${"a".repeat(64)}.png`;
const authors = new Map([["a", { name: "Ada", picture: authorPicture }]]);
const sessionParts = {
  channels: {
    ensureList: () => () => {},
    subscribeList: () => () => {},
    list: () => channelList,
  },
  profiles: {
    snapshot: () => authors,
    subscribe: () => () => {},
    ensure: () => Promise.resolve(),
  },
  media: (url: string, size?: "small") =>
    mediaUrl(url, (target) => target, "https://community", size),
};

it.each([
  "The answer is ||Rosebud||",
  "The answer is ||Rosebud…",
  "The answer is ||decoy || Rosebud || more||",
])("redacts the old saved preview: %s", (preview) => {
  const state = {
    status: "ready",
    reminders: [reminder(preview, "pending", 1, now + 600)],
  };
  page({
    snapshot: () => state,
    subscribe: () => () => {},
  } as unknown as Reminders);
  const row = screen.getByRole("listitem");
  expect(row).toHaveTextContent("The answer is [Spoiler]");
  expect(row).not.toHaveTextContent("Rosebud");
});

it("lists finished reminders newest first in a collapsed Done group", () => {
  const state = {
    status: "ready" as const,
    reminders: [
      reminder("overdue item", "pending", 1, now - 60),
      reminder("older done", "done", 10),
      reminder("newer done", "done", 20),
      reminder("cancelled item", "cancelled", 30),
    ],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    snooze: vi.fn(() => Promise.resolve()),
  } as unknown as Reminders;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders, ...sessionParts },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const open = vi.fn(() => Promise.resolve({ status: "opened" }));
  render(
    <RemindersPage
      relay={relay}
      navigator={{ open } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  const overdue = screen.getByRole("region", { name: "Overdue" });
  expect(within(overdue).queryByText("Ada")).toBeNull();
  expect(within(overdue).queryByText("#general")).toBeNull();
  expect(
    within(overdue).getByRole("button", { name: "More actions: Ada" }),
  ).toBeVisible();
  expect(
    within(overdue).getByText(
      `Due at ${new Date((now - 60) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
      { selector: "time" },
    ),
  ).toBeVisible();
  expect(overdue.querySelector("img")).toHaveAttribute(
    "src",
    authorPicture.replace(/\.png$/, ".thumb.webp"),
  );
  // The row's open action still conveys what the reminder is and when.
  expect(
    within(overdue).getByRole("button", { name: "Open message from Ada" }),
  ).toHaveAccessibleDescription("overdue item Overdue · 1 minute ago");
  const done = screen.getByRole("region", { name: "Done" });
  // Done sits below the active sections, collapsed.
  expect(
    overdue.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const toggle = within(done).getByRole("button", { name: "Done 2" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("newer done")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const rows = within(done).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("newer done"),
    expect.stringContaining("older done"),
  ]);
  // Finished reminders can be opened or brought back, never completed again.
  expect(
    within(rows[0] as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    "Open message from Ada",
    "Remind me again: Ada",
    "Open conversation: #general",
    "More actions: Ada",
  ]);
  expect(screen.queryByText("cancelled item")).toBeNull();
  fireEvent.click(
    within(rows[0] as HTMLElement).getByRole("button", {
      name: "Open message from Ada",
    }),
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "newer done-message" }),
  );
  fireEvent.click(
    within(rows[0] as HTMLElement).getByRole("button", {
      name: "Open conversation: #general",
    }),
  );
  expect(open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://community", viewer },
    channelId: "c",
  });
});

it("marks done, snoozes and cancels a pending reminder from its row", async () => {
  const user = userEvent.setup();
  const state = {
    status: "ready" as const,
    reminders: [reminder("due soon", "pending", 1, now + 600)],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    complete: vi.fn(() => Promise.resolve()),
    snooze: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
  } as unknown as Reminders;
  page(reminders);
  const row = screen.getByRole("listitem");
  expect(within(row).getByText("due soon")).toBeVisible();
  await user.click(
    within(row).getByRole("checkbox", { name: "Mark done: Ada" }),
  );
  expect(reminders.complete).toHaveBeenCalledWith("due soon");
  await user.click(within(row).getByRole("button", { name: "Snooze: Ada" }));
  await user.click(await screen.findByRole("menuitem", { name: /^In 1 hour/ }));
  expect(reminders.snooze).toHaveBeenCalledWith("due soon", expect.any(Number));
  await user.click(
    within(row).getByRole("button", { name: "More actions: Ada" }),
  );
  expect(await screen.findByText("Ada · #general")).toBeVisible();
  await user.click(
    await screen.findByRole("menuitem", { name: "Cancel reminder" }),
  );
  expect(reminders.cancel).toHaveBeenCalledWith("due soon");
});

it("shows a note-only reminder without an open action", () => {
  page([
    {
      id: "note",
      eventId: "note-event",
      createdAt: 1,
      status: "pending",
      notBefore: now + 600,
      note: "stand-up",
    },
    {
      id: "old note",
      eventId: "old-note-event",
      createdAt: 1,
      status: "done",
      note: "retro",
    },
  ]);
  const row = screen.getByRole("listitem");
  // Written reminders are named after their text, with no stand-in avatar.
  expect(
    within(row).getByRole("checkbox", { name: "Mark done: stand-up" }),
  ).toBeVisible();
  expect(
    within(row).getByRole("button", { name: "More actions: stand-up" }),
  ).toBeVisible();
  expect(within(row).queryByRole("img")).toBeNull();
  expect(within(row).getByText("stand-up")).toBeVisible();
  expect(
    within(row).queryByRole("button", { name: /^Open message/ }),
  ).toBeNull();
  // A finished note has nothing to open or cancel, so no empty overflow menu.
  fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
  const done = within(screen.getByRole("region", { name: "Done" })).getByRole(
    "listitem",
  );
  expect(
    within(done)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Remind me again: retro"]);
});

it("names a long written reminder after its shortened first line", () => {
  page([
    {
      id: "long",
      eventId: "long-event",
      createdAt: 1,
      status: "pending",
      notBefore: now + 600,
      note: `${"Renew the insurance policy ".repeat(4)}\nsecond line`,
    },
  ]);
  const [label] = screen
    .getAllByRole("button", { name: /^Snooze: / })
    .map((button) => button.getAttribute("aria-label"));
  expect(label).toMatch(/^Snooze: Renew the insurance policy .+…$/);
  expect(label).not.toContain("second line");
  expect(label?.length).toBeLessThanOrEqual("Snooze: ".length + 60);
});

it("edits a written reminder's text and keeps it required", async () => {
  const user = userEvent.setup();
  const state = {
    status: "ready" as const,
    reminders: [
      {
        id: "note",
        eventId: "note-event",
        createdAt: 1,
        status: "pending" as const,
        notBefore: now + 600,
        note: "stand-up",
      },
    ],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    edit: vi
      .fn(() => Promise.resolve())
      .mockRejectedValueOnce(new Error("offline")),
  } as unknown as Reminders;
  page(reminders);
  await user.click(
    screen.getByRole("button", { name: "More actions: stand-up" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = within(screen.getByRole("dialog", { name: "Edit reminder" }));
  const text = dialog.getByRole("textbox", { name: "Reminder text" });
  const save = dialog.getByRole("button", { name: "Save" });
  expect(text).toHaveValue("stand-up");
  await waitFor(() => expect(text).toHaveFocus());
  await user.clear(text);
  expect(save).toBeDisabled();
  await user.type(text, "Retro{Enter}bring notes");
  await user.click(save);
  expect(await dialog.findByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  expect(text).toHaveValue("Retro\nbring notes");
  await user.click(save);
  expect(reminders.edit).toHaveBeenLastCalledWith("note", "Retro\nbring notes");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("lets a message reminder's note be cleared", async () => {
  const user = userEvent.setup();
  const state = {
    status: "ready" as const,
    reminders: [{ ...reminder("msg", "pending", 1, now + 600), note: "ask" }],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    edit: vi.fn(() => Promise.resolve()),
  } as unknown as Reminders;
  page(reminders);
  await user.click(screen.getByRole("button", { name: "More actions: Ada" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = within(screen.getByRole("dialog", { name: "Edit reminder" }));
  await user.clear(dialog.getByRole("textbox", { name: "Note (optional)" }));
  await user.click(dialog.getByRole("button", { name: "Save" }));
  expect(reminders.edit).toHaveBeenCalledWith("msg", "");
});

it("recovers a failed first history read through Retry, then notifies", async () => {
  vi.useFakeTimers({ now: now * 1000 });
  try {
    const live = {
      id: "live",
      pubkey: viewer,
      kind: 30300,
      created_at: now,
      tags: [
        ["d", "live"],
        ["not_before", String(now + 3)],
      ],
      content: JSON.stringify({ note: "stand-up", status: "pending" }),
      sig: "",
    } as unknown as RelayEvent;
    const query = vi
      .fn<() => Promise<RelayEvent[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);
    const model = createReminders({
      viewer,
      signal: new AbortController().signal,
      host: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: vi.fn(),
      },
      query,
      publish: async () => {},
    });
    const connection = {
      status: "ready",
      scope: `https://community.example:${viewer}`,
      viewer,
      session: {
        reminders: model.capability,
        ...sessionParts,
        live: {
          subscribe: () => () => {},
          snapshot: () => ({ roster: { state: "verified" } }),
        },
      },
    };
    const submit = vi.fn(() => Promise.resolve());
    let Page: () => ReactNode = () => null;
    apply({
      relay: { snapshot: () => connection, subscribe: () => () => {} },
      notifications: { register: () => ({ submit }) },
      pages: {
        registerOverlay() {},
        register: (page: { component: () => ReactNode }) => {
          Page = page.component;
        },
      },
      navigation: {},
      conversation: { registerMessageAction: vi.fn() },
      effect: (body: () => void) => body(),
    } as unknown as Parameters<typeof apply>[0]);
    render(<Page />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const retry = screen.getByRole("button", { name: "Retry reminders" });
    act(() => model.receive([live]));
    await act(() => vi.advanceTimersByTimeAsync(0));
    // The live arrival fills the list, but history is still incomplete.
    expect(screen.getByText("stand-up")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some reminders could not be loaded.",
    );
    fireEvent.click(retry);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(query).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceKey: `live:${now + 3}` }),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("ages due labels while open, with no reminder or live events", async () => {
  // 11:55 PM local, so the run crosses an overdue boundary and midnight.
  const start = new Date(2026, 0, 5, 23, 55).getTime();
  vi.useFakeTimers({ now: start });
  try {
    const at = Math.floor(start / 1000);
    const state = {
      status: "ready" as const,
      hydrated: true,
      reminders: [
        reminder("came due", "pending", 1, at - 30),
        reminder("morning", "pending", 1, at + 9 * 3600 + 5 * 60),
      ],
    };
    const connection = {
      status: "ready",
      scope: `https://community.example:${viewer}`,
      viewer,
      session: {
        reminders: {
          snapshot: () => state,
          subscribe: () => () => {},
          refresh: () => Promise.resolve(),
        },
        ...sessionParts,
        live: {
          subscribe: () => () => {},
          snapshot: () => ({ roster: { state: "verified" } }),
        },
      },
    };
    let Page: () => ReactNode = () => null;
    apply({
      relay: { snapshot: () => connection, subscribe: () => () => {} },
      notifications: { register: () => ({ submit: () => Promise.resolve() }) },
      pages: {
        registerOverlay() {},
        register: (page: { component: () => ReactNode }) => {
          Page = page.component;
        },
      },
      navigation: {},
      conversation: { registerMessageAction: vi.fn() },
      effect: (body: () => void) => body(),
    } as unknown as Parameters<typeof apply>[0]);
    render(<Page />);
    // Rows move between day groups as the clock crosses midnight.
    const labels = () =>
      screen
        .getAllByRole("listitem")
        .map((row) => row.querySelector("[data-reminder-due]")?.textContent);
    expect(labels()).toEqual([
      "Overdue · just now",
      expect.stringMatching(/^Tomorrow at /),
    ]);
    await act(() => vi.advanceTimersByTimeAsync(11 * 60_000));
    expect(labels()).toEqual([
      "Overdue · 11 minutes ago",
      expect.stringMatching(/^Today at /),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

function page(
  source: Reminder[] | Reminders,
  navigator = reminderNavigation(),
) {
  const state = { status: "ready" as const, reminders: source };
  const reminders = Array.isArray(source)
    ? ({
        snapshot: () => state,
        subscribe: () => () => {},
      } as unknown as Reminders)
    : source;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders, ...sessionParts },
  };
  render(
    <ReminderHost
      relay={
        {
          snapshot: () => connection,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      navigator={navigator}
    />,
  );
  return navigator;
}

it("adds custom text from the empty page and lists it without a message link", async () => {
  const user = userEvent.setup();
  const publish = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new Error("offline"));
  const { capability, recover } = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: {
      decode: async (events) =>
        events.map((event) => ({
          eventId: event.id,
          content: JSON.parse(event.content),
        })),
      sign: async (intent) =>
        ({
          id: "saved",
          pubkey: viewer,
          kind: 30300,
          created_at: intent.createdAt,
          content: JSON.stringify(intent.content),
          tags: [
            ["d", intent.d],
            ["not_before", String(intent.notBefore)],
          ],
        }) as RelayEvent,
    },
    query: async () => [],
    publish,
  });
  const navigator = page(capability);
  const trigger = headerNewReminder();
  expect(screen.getByText("Loading reminders…")).toBeVisible();
  await act(async () => recover());
  expect(screen.getByText("No reminders yet")).toBeVisible();
  await user.click(trigger);
  const dialog = within(screen.getByRole("dialog", { name: "New reminder" }));
  const text = dialog.getByRole("textbox", { name: "Reminder text" });
  const save = dialog.getByRole("button", { name: "Set reminder" });
  await user.type(text, "   ");
  expect(save).toBeDisabled();
  await user.type(text, "Renew insurance{Enter}Review deductible");
  await user.click(save);
  expect(await dialog.findByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  expect(text).toHaveValue("   Renew insurance\nReview deductible");
  const before = Math.floor(Date.now() / 1000);
  await user.click(save);
  const row = within(await screen.findByRole("listitem"));
  expect(
    row.getByText("Renew insurance Review deductible", { exact: true })
      .textContent,
  ).toBe("Renew insurance\nReview deductible");
  expect(
    row.queryByRole("button", { name: /Open message|Open conversation/ }),
  ).toBeNull();
  const due = capability.snapshot().reminders[0]?.notBefore;
  expect(due).toBeGreaterThanOrEqual(before + 30 * 60);
  expect(due).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60);
  expect(publish).toHaveBeenCalledTimes(2);
  act(() => navigator.back());
  act(() => navigator.forward());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("restores an unsaved draft through Back and Forward but retires explicitly closed visits", async () => {
  const user = userEvent.setup();
  const navigator = page([]);
  await user.click(headerNewReminder());
  await user.type(
    screen.getByRole("textbox", { name: "Reminder text" }),
    "Keep this draft",
  );
  act(() => navigator.back());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("No reminders yet")).toBeVisible();
  act(() => navigator.back());
  expect(screen.queryByRole("button", { name: "New reminder" })).toBeNull();
  act(() => navigator.forward());
  act(() => navigator.forward());
  expect(
    await screen.findByRole("textbox", { name: "Reminder text" }),
  ).toHaveValue("Keep this draft");
  for (const dismissal of ["Cancel", "Close", "Escape"]) {
    if (dismissal === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: dismissal }));
    act(() => navigator.back());
    act(() => navigator.forward());
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(headerNewReminder());
    expect(
      await screen.findByRole("textbox", { name: "Reminder text" }),
    ).toHaveValue("");
  }
});

it.each(["Cancel", "Set reminder"])(
  "does not recreate an editor while %s waits for native dismissal",
  async (action) => {
    const user = userEvent.setup();
    const navigator = reminderNavigation();
    let finishDismiss!: () => void;
    const state = { status: "ready", hydrated: true, reminders: [] };
    page(
      {
        snapshot: () => state,
        subscribe: () => () => {},
        create: async () => {},
      } as unknown as Reminders,
      {
        ...navigator,
        dismiss: (visits, fallback) => {
          finishDismiss = () => navigator.dismiss(visits, fallback);
        },
      },
    );
    await user.click(headerNewReminder());
    await user.type(
      screen.getByRole("textbox", { name: "Reminder text" }),
      "Finish this draft",
    );
    await user.click(screen.getByRole("button", { name: action }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => finishDismiss());
    await user.click(headerNewReminder());
    expect(screen.getByRole("textbox", { name: "Reminder text" })).toHaveValue(
      "",
    );
  },
);

it("keeps a pending save alive through page traversal and retires it on completion", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const create = vi.fn(() => saved);
  const state = { status: "ready", hydrated: true, reminders: [] };
  const navigation = reminderNavigation();
  let finishDismiss!: () => void;
  const navigator = page(
    {
      snapshot: () => state,
      subscribe: () => () => {},
      create,
    } as unknown as Reminders,
    {
      ...navigation,
      dismiss: (visits, fallback) => {
        finishDismiss = () => navigation.dismiss(visits, fallback);
      },
    },
  );
  await user.click(headerNewReminder());
  await user.type(
    screen.getByRole("textbox", { name: "Reminder text" }),
    "Save once",
  );
  try {
    await user.click(screen.getByRole("button", { name: "Set reminder" }));
    act(() => navigator.back());
    act(() => navigator.back());
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => navigator.forward());
    act(() => navigator.forward());
    expect(
      await screen.findByRole("textbox", { name: "Reminder text" }),
    ).toHaveValue("Save once");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(create).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.any(Number),
      "Save once",
    );
    act(() => {
      void navigator.open({
        ...navigator.snapshot().entry.target,
        join: { viewer, visit: "covering-join" },
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    await act(async () => finish());
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => finishDismiss());
  act(() => navigator.forward());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(create).toHaveBeenCalledTimes(1);
});

it("retires the draft on session replacement and ignores the old save's completion", async () => {
  const user = userEvent.setup();
  const state = { status: "ready", hydrated: true, reminders: [] };
  let resolveSave!: () => void;
  const save = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const firstCreate = vi.fn(() => save);
  const secondCreate = vi.fn(async () => {});
  const navigation = reminderNavigation();
  let finishDismiss!: () => void;
  const navigator: Navigation = {
    ...navigation,
    dismiss: (visits, fallback) => {
      finishDismiss = () => navigation.dismiss(visits, fallback);
    },
  };
  const mount = (create: typeof secondCreate | undefined) => {
    const connection = {
      status: "ready",
      scope: `https://community:${viewer}`,
      viewer,
      session: {
        ...sessionParts,
        reminders: create && {
          create,
          snapshot: () => state,
          subscribe: () => () => {},
        },
      },
    };
    return (
      <ReminderHost
        relay={
          {
            snapshot: () => connection,
            subscribe: () => () => {},
          } as unknown as RelayData
        }
        navigator={navigator}
      />
    );
  };
  const { rerender } = render(mount(undefined));
  const open = () => user.click(headerNewReminder());
  expect(screen.queryByRole("button", { name: "New reminder" })).toBeNull();
  rerender(mount(firstCreate));
  await open();
  await user.type(
    screen.getByRole("textbox", { name: "Reminder text" }),
    "First session",
  );
  try {
    await user.dblClick(screen.getByRole("button", { name: "Set reminder" }));
    expect(firstCreate).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.any(Number),
      "First session",
    );
    rerender(mount(secondCreate));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => finishDismiss());
    await open();
    const text = screen.getByRole("textbox", { name: "Reminder text" });
    expect(text).toHaveValue("");
    await user.type(text, "Second session");
  } finally {
    await act(async () => resolveSave());
  }
  expect(screen.getByRole("textbox", { name: "Reminder text" })).toHaveValue(
    "Second session",
  );
  expect(secondCreate).not.toHaveBeenCalled();
});

it("renders a reminder due past JavaScript's Date range without its due label", () => {
  // The relay accepts any safe-integer not_before; this one has no Date.
  page([reminder("far future", "pending", 1, 8_640_000_000_001)]);
  const row = screen.getByRole("listitem");
  expect(within(row).getByText("far future")).toBeVisible();
  expect(
    within(row).getByRole("button", { name: "Open message from Ada" }),
  ).toHaveAccessibleDescription("far future");
});

/** The page header's action; an empty page repeats it in its empty state. */
function headerNewReminder() {
  const [header] = screen.getAllByRole("button", { name: "New reminder" });
  assert(header);
  return header;
}

const hint = "Write your own, or choose Remind me from a message's menu.";

it("says the list is caught up when only Done reminders exist", () => {
  page([reminder("finished", "done", 1)]);
  expect(screen.getByText("You're all caught up")).toBeVisible();
  expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();
});

it("explains how to add a reminder on an empty page", () => {
  page([reminder("cancelled", "cancelled", 1)]);
  expect(screen.getByText("No reminders yet")).toBeVisible();
  expect(screen.getByText(hint)).toBeVisible();
  expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
});

it("opens a new reminder from the empty state's action", async () => {
  const user = userEvent.setup();
  page([reminder("cancelled", "cancelled", 1)]);
  const [, empty] = screen.getAllByRole("button", { name: "New reminder" });
  assert(empty);
  expect(empty).toHaveTextContent("New reminder");
  await user.click(empty);
  expect(screen.getByRole("dialog", { name: "New reminder" })).toBeVisible();
});

it.each([
  ["an empty", [] as RelayEvent[], "No reminders yet"],
  [
    "a populated",
    [
      {
        id: "kept",
        pubkey: viewer,
        kind: 30300,
        created_at: 1,
        tags: [
          ["d", "kept"],
          ["not_before", String(now + 600)],
        ],
        content: JSON.stringify({ note: "kept note", status: "pending" }),
        sig: "",
      } as unknown as RelayEvent,
    ],
    "kept note",
  ],
])(
  "keeps %s list through a later refresh and offers Retry after it fails",
  async (_, history, visible) => {
    let answer: ((events: RelayEvent[]) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const query = vi.fn(
      () =>
        new Promise<RelayEvent[]>((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    );
    const model = createReminders({
      viewer,
      signal: new AbortController().signal,
      host: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: vi.fn(),
      },
      query,
      publish: async () => {},
    });
    const connection = {
      status: "ready",
      scope: `https://community:${viewer}`,
      viewer,
      session: { reminders: model.capability, ...sessionParts },
    };
    render(
      <RemindersPage
        relay={
          {
            snapshot: () => connection,
            subscribe: () => () => {},
          } as unknown as RelayData
        }
        navigator={{ open: vi.fn() } as unknown as Navigation}
        clock={{ subscribe: () => () => {}, read: () => now }}
      />,
    );
    const read = (settle: () => void) =>
      act(async () => {
        const done = model.capability.refresh();
        await Promise.resolve();
        settle();
        await done;
      });
    await read(() => answer?.(history));
    // Never connected, so not safe to save, yet the loaded list shows.
    expect(model.capability.snapshot().status).toBe("loading");
    expect(screen.queryByText("Loading reminders…")).toBeNull();
    expect(screen.getByText(visible)).toBeVisible();
    // A refresh in flight, such as reconnect recovery, keeps the list on screen.
    const pending = model.capability.refresh();
    act(() => model.stale());
    expect(screen.queryByText("Loading reminders…")).toBeNull();
    expect(screen.getByText(visible)).toBeVisible();
    await act(async () => {
      fail?.(new Error("offline"));
      await pending;
    });
    const failing = model.capability.refresh();
    await act(async () => {
      fail?.(new Error("offline"));
      await failing;
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some reminders could not be loaded.",
    );
    expect(screen.getByText(visible)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry reminders" }));
    await act(async () => {
      answer?.(history);
      await Promise.resolve();
    });
    await act(() => Promise.resolve());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(visible)).toBeVisible();
  },
);

it("keeps keyboard focus on Retry through a pending and failed read, then hands it to the page", async () => {
  const reads: {
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const model = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: { decode: async () => [], sign: vi.fn() },
    query: () =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        reads.push({ resolve, reject }),
      ),
    publish: async () => {},
  });
  void model.recover();
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders: model.capability, ...sessionParts },
  };
  render(
    <RemindersPage
      relay={
        {
          snapshot: () => connection,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  await act(async () => reads.shift()?.reject(new Error("offline")));
  const retry = screen.getByRole("button", { name: "Retry reminders" });
  const user = userEvent.setup();
  retry.focus();
  await user.keyboard("{Enter}");
  // Pending: the same control stays, busy and focused.
  expect(retry).toHaveAttribute("aria-busy", "true");
  expect(retry).toHaveFocus();
  await act(async () => reads.shift()?.reject(new Error("offline")));
  expect(retry).not.toHaveAttribute("aria-busy", "true");
  expect(retry).toHaveFocus();
  await user.keyboard("{Enter}");
  await act(async () => reads.shift()?.resolve([]));
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Reminders" }).firstElementChild,
  ).toHaveFocus();
});

type Read = { resolve(events: RelayEvent[]): void; reject(error: Error): void };

/** A recovered store whose every read waits on `reads`. */
function heldStore() {
  const reads: Read[] = [];
  const model = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: { decode: async () => [], sign: vi.fn() },
    query: () =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        reads.push({ resolve, reject }),
      ),
    publish: async () => {},
  });
  void model.recover();
  return { model, reads };
}

/** Mount the page on a failed first read, then start Retry from the keyboard. */
async function pendingRetry() {
  const first = heldStore();
  let reminders = first.model.capability;
  const listeners = new Set<() => void>();
  let connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders, ...sessionParts },
  };
  render(
    <RemindersPage
      relay={
        {
          snapshot: () => connection,
          subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          },
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  await act(async () => first.reads.shift()?.reject(new Error("offline")));
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Retry reminders" }).focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Retry reminders" }),
  ).toHaveAttribute("aria-busy", "true");
  return {
    user,
    /** Settle the first store's pending Retry read. */
    settle: (outcome: "success" | "failure") =>
      act(async () => {
        const read = first.reads.shift();
        if (outcome === "success") read?.resolve([]);
        else read?.reject(new Error("offline"));
      }),
    /** Same community, new session: its store's first read has settled. */
    async swap(outcome: "success" | "failure") {
      const next = heldStore();
      await act(async () => {
        const read = next.reads.shift();
        if (outcome === "success") read?.resolve([]);
        else read?.reject(new Error("offline"));
        reminders = next.model.capability;
        connection = { ...connection, session: { reminders, ...sessionParts } };
        for (const listener of listeners) listener();
      });
      return next;
    },
  };
}

function elsewhere() {
  const button = document.createElement("button");
  button.textContent = "Community navigation";
  document.body.append(button);
  return button;
}

it("leaves focus where the user moved it when a pending Retry succeeds", async () => {
  const app = await pendingRetry();
  const other = elsewhere();
  try {
    other.focus();
    await app.settle("success");
    expect(
      screen.queryByRole("button", { name: "Retry reminders" }),
    ).toBeNull();
    expect(other).toHaveFocus();
  } finally {
    other.remove();
  }
});

it("shows no stale failure after a swap to a healthy replacement session", async () => {
  const app = await pendingRetry();
  await app.swap("success");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
});

it("lets a failed replacement session retry while the retired Retry is pending", async () => {
  const app = await pendingRetry();
  const next = await app.swap("failure");
  const retry = screen.getByRole("button", { name: "Retry reminders" });
  expect(retry).not.toHaveAttribute("aria-busy", "true");
  expect(retry).toBeEnabled();
  retry.focus();
  await app.user.keyboard("{Enter}");
  expect(retry).toHaveAttribute("aria-busy", "true");
  await act(async () => next.reads.shift()?.resolve([]));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not let the retired session's Retry completion move focus or end a newer Retry", async () => {
  const app = await pendingRetry();
  await app.swap("failure");
  const retry = screen.getByRole("button", { name: "Retry reminders" });
  retry.focus();
  await app.user.keyboard("{Enter}");
  await app.settle("success");
  expect(retry).toHaveFocus();
  expect(retry).toHaveAttribute("aria-busy", "true");
});

/** Renders a control that focuses itself when opened, before the page. */
function withClaim(page: () => ReactNode) {
  let open = false;
  function Claim() {
    const ref = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => {
      if (open) ref.current?.focus();
    });
    return open ? (
      <button type="button" ref={ref}>
        Newly opened control
      </button>
    ) : null;
  }
  const tree = () => (
    <>
      <Claim />
      {page()}
    </>
  );
  return {
    tree,
    open() {
      open = true;
    },
  };
}

function staticPage(connection: () => unknown) {
  return (
    <RemindersPage
      relay={
        {
          snapshot: connection,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />
  );
}

it("keeps focus on a control that claims it in the commit that removes Retry", () => {
  // A store that changes only when the test re-renders, so the failure clears
  // and the claim opens in one commit.
  let state: unknown = {
    status: "ready",
    hydrated: true,
    error: "offline",
    reminders: [],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    refresh: async () => {},
  } as unknown as Reminders;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders, ...sessionParts },
  };
  const claim = withClaim(() => staticPage(() => connection));
  const app = render(claim.tree());
  screen.getByRole("button", { name: "Retry reminders" }).focus();
  state = { status: "ready", hydrated: true, reminders: [] };
  claim.open();
  app.rerender(claim.tree());
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Newly opened control" }),
  ).toHaveFocus();
});

it("keeps focus on a control that claims it as a healthy session replaces a keyboard-started Retry", async () => {
  const first = heldStore();
  await act(async () => first.reads.shift()?.reject(new Error("offline")));
  const next = heldStore();
  await act(async () => next.reads.shift()?.resolve([]));
  let connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders: first.model.capability, ...sessionParts },
  };
  const claim = withClaim(() => staticPage(() => connection));
  const app = render(claim.tree());
  screen.getByRole("button", { name: "Retry reminders" }).focus();
  const user = userEvent.setup();
  await user.keyboard("{Enter}");
  connection = {
    ...connection,
    session: { reminders: next.model.capability, ...sessionParts },
  };
  claim.open();
  await act(async () => {
    app.rerender(claim.tree());
  });
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Newly opened control" }),
  ).toHaveFocus();
  await act(async () => first.reads.shift()?.resolve([]));
});

it("blocks competing row updates while saving and recovers after failure", async () => {
  const user = userEvent.setup();
  let reject!: (reason: Error) => void;
  const complete = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const state = {
    status: "ready",
    reminders: [reminder("follow up", "pending", 1, now + 600)],
  };
  page({
    snapshot: () => state,
    subscribe: () => () => {},
    complete,
  } as unknown as Reminders);
  const checkbox = screen.getByRole("checkbox", { name: "Mark done: Ada" });
  await user.click(checkbox);
  expect(checkbox).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Snooze: Ada" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "More actions: Ada" }),
  ).toBeDisabled();
  expect(complete).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert")).toHaveTextContent("could not be updated");
  expect(checkbox).not.toHaveAttribute("aria-disabled", "true");
  expect(checkbox).not.toBeChecked();
  complete.mockImplementationOnce(async () => {});
  await user.click(checkbox);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("resets completion feedback when the settled write leaves the reminder pending", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const complete = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const state = {
    status: "ready",
    reminders: [reminder("follow up", "pending", 1, now + 600)],
  };
  page({
    snapshot: () => state,
    subscribe: () => () => {},
    complete,
  } as unknown as Reminders);
  const checkbox = screen.getByRole("checkbox", { name: "Mark done: Ada" });
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveAttribute("aria-disabled", "true");
  // A newer relay event can win without the completion promise rejecting.
  await act(async () => finish());
  expect(checkbox).not.toHaveAttribute("aria-disabled", "true");
  expect(checkbox).not.toBeChecked();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(checkbox);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(checkbox).toBeChecked();
  await act(async () => finish());
  expect(checkbox).not.toBeChecked();
});
