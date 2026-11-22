// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData, RelayEvent } from "../../features/relay/events";
import { createRelayReader } from "../../features/relay/reader";
import type { RelayData } from "../../features/relay/service";
import type { ReadTransport } from "../../features/relay/transport";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Profile } from "../../features/relay/contracts";
import { useState } from "react";
import {
  AgentBrowse as Catalog,
  SharedAgentPanel,
  type SharedAgentSelection,
} from "./AgentBrowse";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
function AgentBrowse(
  props: ReturnType<typeof importing> & {
    relay: RelayData;
    onOpen?: (agent: Agent) => void;
    openSettings?: (section: string) => void;
  },
) {
  const [selection, setSelection] = useState<SharedAgentSelection>();
  const [words, setWords] = useState<readonly string[]>([]);
  return (
    <>
      <Catalog
        {...props}
        relay={props.relay}
        selectedId={selection?.agent.id}
        onSelect={setSelection}
        onSearch={setWords}
      />
      {selection && (
        <section aria-label="Shared agent profile">
          <PanelWorkspace
            value={selection.agent.id}
            select={() => {}}
            items={[
              {
                id: selection.agent.id,
                label: selection.agent.name,
                close: () => setSelection(undefined),
                content: (
                  <SharedAgentPanel
                    selection={selection}
                    words={words}
                    {...props}
                  />
                ),
              },
            ]}
          />
        </section>
      )}
    </>
  );
}

afterEach(cleanup);

const echo = {
  key: "test/echo",
  title: "Echo",
  defaults: () => ({ config: { model: "default" } }),
  importShared: (source: { model: string }) => ({ model: source.model }),
} as RegisteredAgentType;
const notes = { key: "test/notes", title: "Notes" } as RegisteredAgentType;
const imported = { pubkey: "e".repeat(64), name: "Shared helper" } as Agent;
/** Import's props: one type, and an `agents` in `status` (with `error`)
 * holding `own` whose `port` resolves. */
const importing = (
  types: readonly RegisteredAgentType[] = [echo],
  own: readonly Agent[] = [],
  status: AgentsSnapshot["status"] = "ready",
  error?: string,
) => {
  const snapshot = { status, error, agents: own };
  return {
    agents: {
      subscribe: () => () => {},
      snapshot: () => snapshot,
      types: () => types,
      port: vi.fn(async () => ({ agent: imported, notes: [] })),
    } as unknown as Agents & { port: ReturnType<typeof vi.fn> },
    types,
    onImported: vi.fn(),
  };
};

const shared: EventData = {
  id: "ab".repeat(32),
  pubkey: "cd".repeat(32),
  created_at: 1,
  kind: 30175,
  tags: [
    ["d", "helper"],
    ["shared", "true"],
  ],
  content: JSON.stringify({
    display_name: "Shared helper",
    model: "test-model",
    system_prompt: "Help with tasks.",
  }),
};

/** A profile directory holding `known`, by pubkey. */
const directory = (known: Record<string, Profile> = {}) => {
  const snapshot = new Map(Object.entries(known));
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    ensure: vi.fn(async () => {}),
  };
};

const viewer = "ef".repeat(32);

/** An outbox whose sends settle as `delivery` says, recording each event. */
const outbox = (
  delivery: (event: { kind: number }) => string = () => "accepted",
) => {
  const sent: {
    id: string;
    kind: number;
    content: string;
    tags: string[][];
  }[] = [];
  let items: { event: { id: string }; delivery: string; error?: string }[] = [];
  const listeners = new Set<() => void>();
  return {
    sent,
    supports: () => true,
    ready: async () => {},
    snapshot: () => items,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: vi.fn(
      (input: { kind: number; content: string; tags: string[][] }) => {
        const id = sent.length.toString(16).padStart(64, "0");
        sent.push({ id, ...input });
        items = [...items, { event: { id }, delivery: "sending" }];
        queueMicrotask(() => {
          const outcome = delivery(input);
          items = items.map((item) =>
            item.event.id === id
              ? { ...item, delivery: outcome, error: "Refused by relay" }
              : item,
          );
          for (const listener of listeners) listener();
        });
        return id;
      },
    ),
    dismiss: vi.fn(async () => {}),
  };
};

/** A ready community whose session reads the catalog through `read` and
 * reactions through `readRemote`. */
const community = (
  read: unknown,
  profiles = directory(),
  {
    readRemote = vi.fn().mockResolvedValue([]),
    writes = outbox(),
  }: { readRemote?: unknown; writes?: ReturnType<typeof outbox> } = {},
) => {
  const snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    viewer,
    session: {
      read,
      readRemote,
      outbox: writes,
      media: () => undefined,
      profiles,
    },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
};

it("browses shared agents and opens their full details", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  const card = await screen.findByRole("button", {
    name: "More about Shared helper",
  });
  // More → its row → the card.
  const listing = card.parentElement?.parentElement
    ?.parentElement as HTMLElement;
  // The card shows who shared it and how its instructions begin.
  expect(within(listing).getByText(/^by npub…/)).toBeVisible();
  expect(within(listing).getByText("Help with tasks.")).toBeVisible();
  expect(read).toHaveBeenCalledWith([{ kinds: [30175], limit: 200 }], {
    signal: expect.any(AbortSignal),
  });
  fireEvent.click(card);
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(
    within(panel).getByRole("region", { name: "Instructions" }),
  ).toHaveTextContent("Help with tasks.");
  expect(within(panel).getByText("test-model")).toBeVisible();
  // Unknown to the profile directory, the sharer shows as their short key.
  expect(within(panel).getByText("Shared by")).toBeVisible();
  expect(within(panel).getByText(/^npub…/)).toBeVisible();
});

it("scrolls to an agent selected from elsewhere, not one chosen here", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  try {
    const read = vi.fn().mockResolvedValue([shared]);
    const relay = community(read);
    const onSelect = vi.fn();
    const view = render(
      <Catalog {...importing()} relay={relay} onSelect={onSelect} />,
    );
    const card = await screen.findByRole("button", {
      name: "More about Shared helper",
    });
    fireEvent.click(card);
    const [{ agent }] = onSelect.mock.calls[0] ?? [];
    view.rerender(
      <Catalog
        {...importing()}
        relay={relay}
        selectedId={agent.id}
        onSelect={onSelect}
      />,
    );
    expect(card).toHaveAttribute("aria-current", "true");
    expect(card.closest("[data-selected]")).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    // As View on a published agent selects it, before its page has loaded.
    view.unmount();
    render(
      <Catalog
        {...importing()}
        relay={relay}
        selectedId={agent.id}
        onSelect={onSelect}
      />,
    );
    const listed = await screen.findByRole("button", {
      name: "More about Shared helper",
    });
    await vi.waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        block: "center",
      }),
    );
    expect(scrollIntoView.mock.contexts[0]).toBe(
      listed.closest("[data-selected]"),
    );
  } finally {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

it("asks to connect while no community is ready", () => {
  const snapshot = { status: "disconnected", generation: 0 };
  render(
    <AgentBrowse
      relay={
        {
          snapshot: () => snapshot,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      {...importing()}
    />,
  );
  expect(
    screen.getByText("Connect to a community to browse shared agents."),
  ).toBeVisible();
});

it("allows retrying a failed read without claiming the community is empty", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  expect(
    screen.queryByText("No shared agents found in this community yet."),
  ).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText("No shared agents found in this community yet."),
  ).toBeVisible();
});

it("reads every page, shrinking over-budget ones, and retries a failure from the start", async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 200 - index,
    tags: [
      ["d", `helper-${Math.floor(index / 100)}`],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: `Helper ${index}`,
      system_prompt: "x".repeat(48 * 1024),
    }),
  })) as RelayEvent[];
  let failNextPage = true;
  const query = vi.fn<ReadTransport["query"]>(async (filters) => {
    const filter = filters[0];
    if (!filter) throw new Error("Missing filter");
    if (filter.until !== undefined && failNextPage) {
      failNextPage = false;
      throw new Error("offline");
    }
    return events
      .filter(
        (event) =>
          filter.until === undefined || event.created_at < filter.until,
      )
      .slice(0, filter.limit);
  });
  const owned = createRelayReader({
    viewer: shared.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    query,
  });
  const view = render(
    <AgentBrowse relay={community(owned.reader.read)} {...importing()} />,
  );
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    // Both heads, one from each page, once every page is read.
    expect(await screen.findByText("Helper 0")).toBeVisible();
    expect(screen.getByText("Helper 100")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^More about Helper / }),
    ).toHaveLength(2);
    expect(
      query.mock.calls.slice(0, 2).map(([filters]) => filters[0]?.limit),
    ).toEqual([200, 100]);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  } finally {
    view.unmount();
    owned.dispose();
  }
});

it("starts over in another community", async () => {
  const first = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({ display_name: "First helper" }),
    },
  ]);
  const second = vi.fn().mockResolvedValue([shared]);
  const session = (read: unknown) => ({
    read,
    readRemote: vi.fn().mockResolvedValue([]),
    outbox: outbox(),
    media: () => undefined,
    profiles: directory(),
  });
  let snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://one.example",
    viewer,
    session: session(first),
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  render(<AgentBrowse relay={relay} {...importing()} />);
  await screen.findByText("First helper");
  snapshot = {
    status: "ready",
    generation: 2,
    origin: "https://two.example",
    viewer,
    session: session(second),
  };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(screen.queryByText("First helper")).not.toBeInTheDocument();
  expect(second).toHaveBeenCalledExactlyOnceWith(
    [{ kinds: [30175], limit: 200 }],
    { signal: expect.any(AbortSignal) },
  );
});

it("names the sharer by their profile, with their key on hover", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const profiles = directory({ [shared.pubkey]: { name: "Cora" } });
  render(<AgentBrowse relay={community(read, profiles)} {...importing()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  const dialog = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(within(dialog).getByText("Cora")).toBeVisible();
  expect(within(dialog).queryByText(/^npub…/)).not.toBeInTheDocument();
  expect(profiles.ensure).toHaveBeenCalledWith([shared.pubkey]);
  expect(within(dialog).getByText("test-model")).toBeVisible();
});

it("imports a shared agent through the import path, then hands back", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        system_prompt: "Help with tasks.",
        avatar_url: "https://example.test/helper.png",
      }),
    },
  ]);
  const props = importing();
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  const dialog = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(within(dialog).queryByLabelText("Import as")).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Shared helper",
  });
  // Laid out as the Identity tab: the type it runs as is chosen in place.
  expect(
    within(confirmation).getByRole("combobox", { name: "Harness" }),
  ).toBeVisible();
  expect(
    within(confirmation).getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Help with tasks.");
  expect(props.agents.port).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Import" }));
  await vi.waitFor(() =>
    expect(props.onImported).toHaveBeenCalledExactlyOnceWith(imported),
  );
  expect(props.agents.port).toHaveBeenCalledExactlyOnceWith({
    source: "shared",
    type: "test/echo",
    name: "Shared helper",
    picture: "https://example.test/helper.png",
    instructions: "Help with tasks.",
    config: { model: "test-model" },
  });
});

it("says how to import, and undoes edits back to what was shared", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(dialog).toHaveAccessibleDescription(
    "Import it as is, or edit anything below first. Changes only affect your copy.",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Undo changes" }),
  ).not.toBeInTheDocument();
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  fireEvent.change(instructions, { target: { value: "Help with less." } });
  expect(dialog).toHaveAccessibleDescription(
    "Edited. Changes only affect your copy.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Undo changes" }));
  expect(instructions).toHaveValue("Help with tasks.");
  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toHaveFocus();
  expect(
    within(dialog).queryByRole("button", { name: "Undo changes" }),
  ).not.toBeInTheDocument();
});

it("offers to open an agent you already have rather than copy it", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        runtime: "test/echo",
        system_prompt: "Help with tasks.",
      }),
    },
  ]);
  const mine = {
    pubkey: "f".repeat(64),
    name: "Shared helper",
    type: "test/echo",
    config: { model: "test-model" },
  } as unknown as Agent;
  const props = importing(
    [
      {
        ...echo,
        exportShared: () => ({ model: "test-model", runtime: "test/echo" }),
        carry: () => ({ instructions: "Help with tasks." }),
      } as unknown as RegisteredAgentType,
    ],
    [mine],
  );
  const onOpen = vi.fn();
  render(<AgentBrowse relay={community(read)} {...props} onOpen={onOpen} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(dialog).toHaveAccessibleDescription("You already have this agent.");
  expect(
    within(dialog).queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open Shared helper" }),
  );
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(mine);
  // A second copy stays a choice.
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Import a copy" }),
  );
  await vi.waitFor(() => expect(props.onImported).toHaveBeenCalledOnce());
});

it("refuses a shared agent whose instructions block/buzz would refuse", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        system_prompt: "Help \u202Ewith tasks.",
      }),
    },
  ]);
  const props = importing();
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Import" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Shared helper",
  });
  expect(within(confirmation).getByRole("alert")).toHaveTextContent(
    "Agent instructions contains prohibited invisible or formatting character U+202E",
  );
  const confirm = within(confirmation).getByRole("button", { name: "Import" });
  expect(confirm).toBeDisabled();
  fireEvent.click(confirm);
  expect(props.agents.port).not.toHaveBeenCalled();
});

it("imports as the chosen type, and keeps the panel open with the error when it fails", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([echo, notes]);
  props.agents.port.mockRejectedValueOnce(
    new Error("Connect to a community first"),
  );
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  const dialog = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Shared helper",
  });
  expect(
    within(confirmation).queryByRole("button", { name: "Change settings" }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Import" }));
  expect(await within(confirmation).findByRole("alert")).toHaveTextContent(
    "Connect to a community first",
  );
  expect(props.onImported).not.toHaveBeenCalled();
  expect(props.agents.port).toHaveBeenCalledWith(
    expect.objectContaining({ source: "shared", type: "test/echo" }),
  );
});

it("does not silently replace an unavailable shared runtime", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([{ ...echo, importShared: () => undefined }]);
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(within(dialog).getByRole("button", { name: "Import" })).toBeDisabled();
  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toBeVisible();
  expect(props.agents.port).not.toHaveBeenCalled();
});

/** Opens a shared agent's Import dialog with no type to import as, while
 * Agents is in `status`. */
async function noTypes(
  status: AgentsSnapshot["status"],
  openSettings = vi.fn(),
  error?: string,
) {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([], [], status, error);
  render(
    <AgentBrowse
      relay={community(read)}
      {...props}
      openSettings={openSettings}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  return screen.getByRole("dialog", { name: "Shared helper" });
}

// Desktop where no plugin registered a type that runs agents here: every
// agent plugin off, or one on that failed to activate. The component cannot
// tell these apart, so it names what is missing, not why.
it("says why a shared agent can't be imported here, and links Manage plugins", async () => {
  const openSettings = vi.fn();
  const dialog = await noTypes("ready", openSettings);
  expect(
    within(dialog).getByText(/No harness that runs agents on this computer/),
  ).toHaveTextContent(
    "No harness that runs agents on this computer is available. Check Manage plugins.",
  );
  expect(within(dialog).getByRole("button", { name: "Import" })).toBeDisabled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage plugins" }),
  );
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plugins");
  // Settings opens in place of the dialog, not over it.
  expect(
    screen.queryByRole("dialog", { name: "Shared helper" }),
  ).not.toBeInTheDocument();
});

// Only a hosted type is on, so Manage plugins shows a plugin enabled. The
// page keeps hosted types out of Import, since an imported agent needs a key
// here, and the dialog must not claim no plugin is on.
it("does not say no plugin is on when only a hosted type is", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([], [], "ready");
  const hosted = [
    { ...echo, key: "test/cloud", title: "Cloud", remote: {} },
  ] as unknown as RegisteredAgentType[];
  props.agents.types = () => hosted;
  const openSettings = vi.fn();
  render(
    <AgentBrowse
      relay={community(read)}
      {...props}
      openSettings={openSettings}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(
    within(dialog).getByText(/No harness that runs agents on this computer/),
  ).toHaveTextContent(
    "No harness that runs agents on this computer is available. Check Manage plugins.",
  );
  expect(within(dialog).queryByText(/plugin is turned on/)).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage plugins" }),
  );
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plugins");
});

it("keeps Manage plugins plain text while a shared agent is still importing", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing();
  let fail = () => {};
  props.agents.port.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = () => reject(new Error("Keychain access was denied"));
      }),
  );
  const openSettings = vi.fn();
  const view = render(
    <AgentBrowse
      relay={community(read)}
      {...props}
      openSettings={openSettings}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(props.agents.port).toHaveBeenCalledTimes(1);
  // The last agent plugin goes off while the import is still running.
  const gone = importing([]);
  view.rerender(
    <AgentBrowse
      relay={community(read)}
      {...props}
      agents={gone.agents}
      types={gone.types}
      openSettings={openSettings}
    />,
  );
  expect(
    within(dialog).getByText(/No harness that runs agents on this computer/),
  ).toHaveTextContent(
    "No harness that runs agents on this computer is available. Check Manage plugins.",
  );
  // Opening Settings would close the dialog over the import, which Close
  // may not do either, so the link waits as plain text.
  expect(
    within(dialog).queryByRole("button", { name: "Manage plugins" }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
  await act(async () => {
    fail();
  });
  // The import's outcome still lands in the dialog, and the link is back.
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage plugins" }),
  );
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plugins");
  expect(
    screen.queryByRole("dialog", { name: "Shared helper" }),
  ).not.toBeInTheDocument();
});

it("tells a browser that shared agents import only in the desktop app", async () => {
  // Outside the desktop app Agents is unavailable and no type registers.
  const dialog = await noTypes("unavailable");
  expect(
    within(dialog).getByText(
      "Agents runs in the desktop app. Open Buzz there to import one.",
    ),
  ).toBeVisible();
  expect(within(dialog).queryByText(/Manage plugins/)).not.toBeInTheDocument();
});

it("says a shared agent can't be imported while Agents could not load", async () => {
  const dialog = await noTypes("error", vi.fn(), "Keychain is locked.");
  expect(
    within(dialog).getByText("Agents could not load. Keychain is locked."),
  ).toBeVisible();
  expect(within(dialog).queryByText(/Manage plugins/)).not.toBeInTheDocument();
});

it("waits for agent types to register instead of asking for a plugin", async () => {
  const dialog = await noTypes("loading");
  // Loading feedback is delayed a second, as LoadingRegion does everywhere.
  expect(
    await within(dialog).findByRole("status", undefined, { timeout: 2000 }),
  ).toHaveTextContent("Loading agent types…");
  expect(
    within(dialog).queryByText(/No harness that runs agents on this computer/),
  ).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/Manage plugins/)).not.toBeInTheDocument();
});

it("shows long instructions in full, with no See more", async () => {
  const long = "Long instructions. ".repeat(100).trim();
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        system_prompt: long,
      }),
    },
  ]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  expect(
    await screen.findByRole("region", { name: "Instructions" }),
  ).toHaveTextContent(long);
  expect(screen.queryByRole("button", { name: "See more" })).toBeNull();
});

it("reloads a catalog refused while signed out once the organization signs in", async () => {
  const { createRecovery } = await import("../../features/relay/recovery");
  const recovery = createRecovery([]);
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Federated sign-in is required"))
    .mockResolvedValue([shared]);
  const relay = community(read);
  Object.assign(relay.snapshot().session, { recovery });
  render(<AgentBrowse relay={relay} {...importing()} />);
  expect(await screen.findByText("Couldn’t load shared agents.")).toBeVisible();
  act(() => recovery.retryAll());
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
  recovery.dispose();
});

/** A shared agent named `name` by `owner`, with `instructions`. */
const listing = (
  name: string,
  { owner = shared.pubkey, instructions = "", created_at = 1 } = {},
): EventData => ({
  ...shared,
  id: `${name}:${owner}`.padEnd(64, "0").replace(/[^0-9a-f]/g, "0"),
  pubkey: owner,
  created_at,
  tags: [
    ["d", name.toLowerCase()],
    ["shared", "true"],
  ],
  content: JSON.stringify({ display_name: name, system_prompt: instructions }),
});
const reactionOn = (
  agent: EventData,
  content: string,
  pubkey: string,
  id = `${content}${pubkey}${agent.id}`,
): EventData => ({
  id,
  pubkey,
  created_at: 2,
  kind: 7,
  content,
  tags: [
    ["e", agent.id],
    ["a", `30175:${agent.pubkey}:${agent.tags[0]?.[1]}`],
    ["k", "30175"],
  ],
});
const cardNames = () =>
  screen
    .getAllByRole("button", { name: /^More about (Alpha|Beta|Gamma)$/ })
    .map((button) => button.getAttribute("aria-label")?.slice(11));

it("counts stars and imports by address, most starred first, and never the owner's own import", async () => {
  const alpha = listing("Alpha");
  const beta = listing("Beta");
  const gamma = listing("Gamma", { created_at: 5 });
  const readRemote = vi
    .fn()
    .mockResolvedValue([
      reactionOn(beta, "⭐", "a1".repeat(32)),
      reactionOn(beta, "⭐", "a2".repeat(32)),
      reactionOn(gamma, "⭐", "a1".repeat(32)),
      reactionOn(alpha, "📥", "a1".repeat(32)),
      reactionOn(alpha, "📥", alpha.pubkey),
      reactionOn(alpha, "👍", "a3".repeat(32)),
    ]);
  render(
    <AgentBrowse
      relay={community(
        vi.fn().mockResolvedValue([alpha, beta, gamma]),
        directory(),
        { readRemote },
      )}
      {...importing()}
    />,
  );
  await screen.findByText("Alpha");
  expect(readRemote).toHaveBeenCalledWith(
    [
      {
        kinds: [7],
        "#a": [alpha, beta, gamma].map(
          (agent) => `30175:${agent.pubkey}:${agent.tags[0]?.[1]}`,
        ),
        limit: 500,
      },
    ],
    { signal: expect.any(AbortSignal) },
  );
  expect(cardNames()).toEqual(["Beta", "Gamma", "Alpha"]);
  expect(
    screen.getByRole("button", { name: "Star Beta, 2 stars" }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    screen.getAllByRole("button", { name: /^Import \w+, 1 import$/ }),
  ).toHaveLength(1);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Sort" }));
  await user.click(await screen.findByRole("option", { name: "Newest" }));
  await vi.waitFor(() => expect(cardNames()[0]).toBe("Gamma"));
});

it("searches names and instructions, highlights matches, and filters by creator", async () => {
  const other = "b1".repeat(32);
  const read = vi
    .fn()
    .mockResolvedValue([
      listing("Alpha", { instructions: "Reviews pull requests." }),
      listing("Beta", { owner: other, instructions: "Plans product reviews." }),
      listing("Gamma", { instructions: "Writes release notes." }),
    ]);
  render(
    <AgentBrowse
      relay={community(read, directory({ [other]: { name: "Bea" } }))}
      {...importing()}
    />,
  );
  await screen.findByText("Alpha");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), {
    target: { value: "review" },
  });
  await vi.waitFor(() => expect(cardNames()).toEqual(["Alpha", "Beta"]));
  expect(screen.getByText("2 of 3 agents")).toBeVisible();
  expect(
    [...document.querySelectorAll("mark")].map((mark) => mark.textContent),
  ).toEqual(["Review", "review"]);
  fireEvent.click(screen.getByRole("combobox", { name: "Creator" }));
  fireEvent.click(await screen.findByRole("option", { name: "Bea" }));
  expect(cardNames()).toEqual(["Beta"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), {
    target: { value: "release" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Clear search" }));
  await vi.waitFor(() => expect(cardNames()).toHaveLength(3));
});

it("stars from the card and unstars from the panel, one deletion per reaction", async () => {
  const alpha = listing("Alpha");
  const writes = outbox();
  const readRemote = vi
    .fn()
    .mockResolvedValue([reactionOn(alpha, "⭐", "a1".repeat(32))]);
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([alpha]), directory(), {
        readRemote,
        writes,
      })}
      {...importing()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Star Alpha, 1 star" }),
  );
  const starred = await screen.findAllByRole("button", {
    name: "Unstar Alpha, 2 stars",
  });
  expect(starred[0]).toHaveAttribute("aria-pressed", "true");
  expect(writes.sent[0]).toMatchObject({
    kind: 7,
    content: "⭐",
    tags: [
      ["e", alpha.id],
      ["a", `30175:${alpha.pubkey}:alpha`],
      ["k", "30175"],
    ],
  });
  // Opened beside the grid, the agent shows the same star.
  fireEvent.click(screen.getByRole("button", { name: "More about Alpha" }));
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  await vi.waitFor(() => expect(writes.dismiss).toHaveBeenCalled());
  fireEvent.click(
    within(panel).getByRole("button", { name: "Unstar Alpha, 2 stars" }),
  );
  expect(
    await screen.findAllByRole("button", { name: "Star Alpha, 1 star" }),
  ).toHaveLength(2);
  expect(writes.sent[1]).toEqual({
    id: expect.any(String),
    kind: 5,
    content: "",
    tags: [
      ["e", writes.sent[0]?.id],
      ["k", "7"],
    ],
  });
});

it("rolls a refused star back and says why", async () => {
  const writes = outbox(() => "failed");
  render(
    <AgentBrowse
      relay={community(
        vi.fn().mockResolvedValue([listing("Alpha")]),
        directory(),
        { writes },
      )}
      {...importing()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Star Alpha, 0 stars" }),
  );
  expect(
    await screen.findByText("Couldn’t star: Refused by relay"),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Star Alpha, 0 stars" }),
  ).toHaveAttribute("aria-pressed", "false");
  // A refused write is retired, never retried.
  expect(writes.dismiss).toHaveBeenCalledWith(writes.sent[0]?.id);
});

it("keeps browsing when stars can't load, without stars or import counts", async () => {
  render(
    <AgentBrowse
      relay={community(
        vi.fn().mockResolvedValue([listing("Alpha")]),
        directory(),
        { readRemote: vi.fn().mockRejectedValue(new Error("offline")) },
      )}
      {...importing()}
    />,
  );
  const imports = await screen.findByRole("button", { name: "Import Alpha" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: /^Star Alpha/ })).toBeNull(),
  );
  expect(imports).toHaveTextContent(/^$/);
  fireEvent.click(screen.getByRole("button", { name: "More about Alpha" }));
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(within(panel).queryByRole("button", { name: /^Star/ })).toBeNull();
  expect(within(panel).queryByText("Imports")).toBeNull();
});

it("marks the search in the panel, and shows when the agent was updated", async () => {
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([shared]))}
      {...importing()}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "More about Shared helper" }),
  );
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(within(panel).getByText("Updated")).toBeVisible();
  expect(panel.querySelectorAll("mark")).toHaveLength(0);
  await user.type(
    screen.getByRole("searchbox", { name: "Search agents" }),
    "model",
  );
  await vi.waitFor(() =>
    expect(
      [...panel.querySelectorAll("mark")].map((mark) => mark.textContent),
    ).toEqual(["model"]),
  );
});

it("records an import from the panel once, publicly", async () => {
  const alpha = listing("Alpha", { owner: "c1".repeat(32) });
  const writes = outbox();
  const props = importing();
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([alpha]), directory(), {
        writes,
      })}
      {...props}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Alpha" }),
  );
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Import" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(
      /Imports from the Marketplace are counted publicly/,
    ),
  ).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  await vi.waitFor(() => expect(props.onImported).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(writes.sent).toEqual([
      expect.objectContaining({ kind: 7, content: "📥" }),
    ]),
  );
  // The card counts it at once; the dialog, still open, hides the grid.
  expect(
    await screen.findByRole("button", {
      name: "Import Alpha, 1 import",
      hidden: true,
    }),
  ).toBeInTheDocument();
});

it("marks search matches after an emoji on the right letters", async () => {
  render(
    <AgentBrowse
      relay={community(
        vi
          .fn()
          .mockResolvedValue([
            listing("Reviewer", { instructions: "🤖🤖 You review code." }),
          ]),
        directory(),
      )}
      {...importing()}
    />,
  );
  await screen.findByText("Reviewer");
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("searchbox", { name: "Search agents" }),
    "review",
  );
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll("mark")].map((mark) => mark.textContent),
    ).toEqual(["Review", "review"]),
  );
});

it("opens the import dialog from a card's import count", async () => {
  const alpha = listing("Alpha", { owner: "c1".repeat(32) });
  const writes = outbox();
  const props = importing();
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([alpha]), directory(), {
        writes,
      })}
      {...props}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Import Alpha, 0 imports" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(
      /Imports from the Marketplace are counted publicly/,
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Shared agent profile" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  await vi.waitFor(() => expect(props.onImported).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(writes.sent).toEqual([
      expect.objectContaining({ kind: 7, content: "📥" }),
    ]),
  );
});

it("keeps a card in place when you star it, until the list is sorted again", async () => {
  const alpha = listing("Alpha");
  const beta = listing("Beta");
  const readRemote = vi
    .fn()
    .mockResolvedValue([reactionOn(alpha, "⭐", viewer)]);
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([alpha, beta]), directory(), {
        readRemote,
      })}
      {...importing()}
    />,
  );
  await screen.findByText("Alpha");
  expect(cardNames()).toEqual(["Alpha", "Beta"]);
  fireEvent.click(screen.getByRole("button", { name: "Star Beta, 0 stars" }));
  fireEvent.click(screen.getByRole("button", { name: "Unstar Alpha, 1 star" }));
  await screen.findByRole("button", { name: "Unstar Beta, 1 star" });
  await screen.findByRole("button", { name: "Star Alpha, 0 stars" });
  expect(cardNames()).toEqual(["Alpha", "Beta"]);
});

it("reads counts once per session, and again only for agents new since", async () => {
  const alpha = listing("Alpha");
  const beta = listing("Beta");
  const read = vi.fn().mockResolvedValue([alpha]);
  const readRemote = vi.fn().mockResolvedValue([]);
  const relay = community(read, directory(), { readRemote });
  const view = render(<AgentBrowse relay={relay} {...importing()} />);
  await screen.findByText("Alpha");
  view.unmount();
  read.mockResolvedValue([alpha, beta]);
  render(<AgentBrowse relay={relay} {...importing()} />);
  await screen.findByText("Beta");
  // Everyone's reactions, then your own, for each load.
  expect(readRemote).toHaveBeenCalledTimes(4);
  const betaOnly = { kinds: [7], "#a": [`30175:${beta.pubkey}:beta`] };
  expect(readRemote.mock.calls.slice(2).map((call) => call[0])).toEqual([
    [{ ...betaOnly, limit: 500 }],
    [{ ...betaOnly, authors: [viewer], limit: 500 }],
  ]);
});

it("shows agents without counts when counts take more than 5 seconds", async () => {
  vi.useFakeTimers();
  try {
    render(
      <AgentBrowse
        relay={community(
          vi.fn().mockResolvedValue([listing("Alpha")]),
          directory(),
          { readRemote: vi.fn(() => new Promise(() => {})) },
        )}
        {...importing()}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(screen.queryByText("Alpha")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("Alpha")).toBeVisible();
    // Still loading: no count, and nothing to toggle yet.
    expect(screen.getByRole("button", { name: "Star Alpha" })).toBeDisabled();
  } finally {
    vi.useRealTimers();
  }
});

it("finds your own star even when everyone's reactions miss it", async () => {
  const alpha = listing("Alpha");
  const readRemote = vi.fn(async ([filter]: { authors?: string[] }[]) =>
    filter?.authors ? [reactionOn(alpha, "⭐", viewer)] : [],
  );
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([alpha]), directory(), {
        readRemote,
      })}
      {...importing()}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Unstar Alpha, 1 star" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("records nothing, and says nothing public, when you import your own agent", async () => {
  const mine = listing("Alpha", { owner: viewer });
  const writes = outbox();
  const props = importing();
  render(
    <AgentBrowse
      relay={community(vi.fn().mockResolvedValue([mine]), directory(), {
        writes,
      })}
      {...props}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More about Alpha" }),
  );
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Import" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByText(/counted publicly/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  await vi.waitFor(() => expect(props.onImported).toHaveBeenCalled());
  expect(writes.sent).toEqual([]);
});

it("publishes no import record when counts arrive after Import was pressed without the notice", async () => {
  const alpha = listing("Alpha", { owner: "c1".repeat(32) });
  let release: (events: EventData[]) => void = () => {};
  const counts = new Promise<EventData[]>((resolve) => {
    release = resolve;
  });
  let finish: () => void = () => {};
  const props = importing();
  props.agents.port.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ agent: imported, notes: [] });
      }),
  );
  const writes = outbox();
  vi.useFakeTimers();
  try {
    render(
      <AgentBrowse
        relay={community(vi.fn().mockResolvedValue([alpha]), directory(), {
          readRemote: vi.fn(() => counts),
          writes,
        })}
        {...props}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    fireEvent.click(screen.getByRole("button", { name: "More about Alpha" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const panel = screen.getByRole("region", { name: "Shared agent profile" });
    fireEvent.click(within(panel).getByRole("button", { name: "Import" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/counted publicly/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    // Counts load while the import is still running.
    await act(async () => {
      release([]);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(props.onImported).toHaveBeenCalled();
    expect(writes.sent).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
