// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useSyncExternalStore } from "react";
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
import type { Agent, AgentChange, Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";
import {
  chooseDefaultAgent,
  setDefaultAgent,
} from "../../features/solo/default-agent";
import { onBestieMade } from "../agents/BestieChoice";
import { bestieTab, formerBestieTab } from "./BestieTab";
import {
  forgetHostedInstructions,
  readFormerHosted,
  startHostedRead,
} from "./former";
import { validateObject } from "../../features/agents/attention";
import { dream, interestText, memory, notes, withFeature } from "./features";
import { Receipts } from "./updates";

afterEach(() => {
  cleanup();
  localStorage.clear();
  forgetHostedInstructions();
});

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const NO_CHANNELS = { channels: [] };
const DM = "0f0f0f0f-0000-4000-8000-000000000001";
const member = (name: string, digit: string): Agent =>
  ({
    key: digit.repeat(64),
    pubkey: digit.repeat(64),
    name,
    type: "test/echo",
    owner: OWNER,
    relay: "wss://relay.example",
    place: "here",
    attention: {},
  }) as unknown as Agent;
const ada = member("Ada", "a");
const bea = member("Bea", "b");
const navigation = { open: vi.fn(async () => ({ status: "opened" })) } as never;
const settingsCards = { has: () => true, subscribe: () => () => {} };

/** Agents that save as a synced editor would: the agent's next config.
 * `listed` are the agents it finds, Ada and Bea, both on this device. */
function host(types = ["test/echo"], listed: Agent[] = [ada, bea]) {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = {
    save,
    hostedInstructions: () => undefined,
    types: () => types.map((key) => ({ key, adopt: () => ({}) })),
    find: (pubkey: string) => listed.find((each) => each.pubkey === pubkey),
  } as unknown as Pick<Agents, "save" | "types" | "find">;
  return { agents, save };
}

function community(saved: string | null | undefined, agents = [ada, bea]) {
  let record: string | null | undefined = saved;
  const choice = (agent: Agent) => ({
    pubkey: agent.pubkey,
    name: agent.name,
    managed: true,
  });
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: agents.map(choice),
    selectable: agents.map(choice),
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: vi.fn(async () => record),
    // None reads back as a saved none, as the account's reader does.
    write: vi.fn(async (agent: string | null) => {
      record = agent;
    }),
  };
  const connection = {
    status: "ready",
    scope: SCOPE,
    session: {
      viewer: OWNER,
      directMessages: { open: vi.fn(async () => DM) },
      channels: {
        list: () => NO_CHANNELS,
        subscribeList: () => () => {},
        ensureList: () => () => {},
      },
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  let current: unknown = connection;
  const relayListeners = new Set<() => void>();
  const relay = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => void relayListeners.delete(listener);
    },
  } as unknown as RelayData;
  /** Replaces the session, as a reconnection does. */
  const reconnect = (scope: string) => {
    current = {
      ...connection,
      scope,
      session: { ...connection.session, mainAgent: { ...mainAgent } },
    };
    for (const listener of relayListeners) listener();
  };
  return { relay, mainAgent, reconnect };
}

it("shows on the saved Bestie only, and moves when Change picks another", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  const tab = bestieTab(relay, host([]).agents, navigation, settingsCards);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  // Nothing shows before the account's choice is read.
  expect(tab.when?.(ada)).toBe(false);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  expect(tab.when?.(bea)).toBe(false);
  // The same agent in another community is not this one's Bestie.
  expect(tab.when?.({ ...ada, relay: "wss://other.example" })).toBe(false);

  const Tab = tab.component;
  render(<Tab agent={ada} />);
  expect(screen.getByText("This is your Bestie")).toBeVisible();
  // A type without instructions has nothing to switch.
  expect(screen.getByText("Remembers you")).toBeVisible();
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  changed.mockClear();
  await user.click(screen.getByRole("button", { name: "Change" }));
  // Change offers every other agent you can make Bestie.
  expect(screen.queryByRole("menuitem", { name: "Ada" })).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(bea.pubkey);
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(true));
  expect(tab.when?.(ada)).toBe(false);
  // The host is told, so the tab moves without a reload.
  expect(changed).toHaveBeenCalled();
  stop?.();
});

it("shows the Bestie's cost for the week, without a failed read stopping the tab", async () => {
  const { relay } = community(ada.pubkey);
  const usage = vi.fn().mockRejectedValue(new Error("unreadable"));
  const agents = {
    ...host().agents,
    types: () => [{ key: "test/echo", adopt: () => ({}), usage }],
  } as unknown as Parameters<typeof bestieTab>[1];
  const tab = bestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  render(<Tab agent={ada} />);
  expect(await screen.findByText("Cost, last 7 days")).toBeVisible();
  expect(
    await screen.findByText("Couldn't read this agent's sessions."),
  ).toBeVisible();
  // The rest of the tab is where it was.
  expect(screen.getByText("This is your Bestie")).toBeVisible();
  expect(usage).toHaveBeenCalledTimes(1);
  stop?.();
});

it("shows no cost on a Bestie or a Former Bestie, and reads none, while Usage is off", async () => {
  const usage = vi.fn(async () => []);
  const agents = {
    ...host().agents,
    types: () => [{ key: "test/echo", adopt: () => ({}), usage }],
  } as unknown as Parameters<typeof bestieTab>[1];
  const usageOff = { has: () => false, subscribe: () => () => {} };
  const bestie = community(ada.pubkey);
  const tab = bestieTab(bestie.relay, agents, navigation, usageOff);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  expect(screen.getByText("This is your Bestie")).toBeVisible();
  expect(screen.queryByText("Cost, last 7 days")).toBeNull();
  unmount();
  stop?.();

  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const former = formerBestieTab(
    community(bea.pubkey).relay,
    agents,
    navigation,
    usageOff,
  );
  const stopFormer = former.subscribe?.(() => {});
  await vi.waitFor(() => expect(former.when?.(remembering)).toBe(true));
  const Former = former.component;
  render(<Former agent={remembering} />);
  expect(screen.getByText("Private channels Ada can read")).toBeVisible();
  expect(screen.queryByText("Cost, last 7 days")).toBeNull();
  expect(usage).not.toHaveBeenCalled();
  stopFormer?.();
});

const deviceChoice = () => readView(SCOPE, "solo:default-agent", null);

/** Opens Change and confirms Bea in place of Ada. */
async function switchToBea(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  return confirmation;
}

it("puts this device back on the account's Bestie when a failed Change is closed with the panel", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  const tab = bestieTab(relay, host([]).agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  const confirmation = await switchToBea(user);
  expect(await within(confirmation).findByRole("alert")).toBeVisible();
  expect(deviceChoice()).toBe(bea.pubkey);
  // Closing the side panel, not Keep.
  unmount();
  expect(deviceChoice()).toBe(ada.pubkey);
  stop?.();
});

it("keeps the Bestie an agent saved when its tab closes over a failed Change", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  const tab = bestieTab(relay, host([]).agents, navigation, settingsCards);
  const subscribe = tab.subscribe ?? (() => () => {});
  const stop = subscribe(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  // As the side panel does, it drops the tab once Ada stops being Bestie.
  function Panel() {
    const shown = useSyncExternalStore(subscribe, () => !!tab.when?.(ada));
    return shown ? <Tab agent={ada} /> : null;
  }
  render(<Panel />);
  const confirmation = await switchToBea(user);
  expect(await within(confirmation).findByRole("alert")).toBeVisible();
  // An agent saves Bea, as bestie_set does, while the failure shows.
  const { session } = relay.snapshot() as unknown as { session: RelaySession };
  await act(() => chooseDefaultAgent(session, SCOPE, bea.pubkey));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mainAgent.write).toHaveBeenLastCalledWith(bea.pubkey);
  expect(deviceChoice()).toBe(bea.pubkey);
  stop();
});

it("puts this device back when a Change still saving fails after the panel closes", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  let fail = (_: Error) => {};
  mainAgent.write.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const tab = bestieTab(relay, host([]).agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  await switchToBea(user);
  expect(deviceChoice()).toBe(bea.pubkey);
  unmount();
  await act(async () => fail(new Error("offline")));
  expect(deviceChoice()).toBe(ada.pubkey);
  stop?.();
});

it("offers a remote agent in Change, and says what it can't do before switching", async () => {
  const user = userEvent.setup();
  const cara = { ...member("Cara", "c"), place: "hosted" } as Agent;
  const { relay, mainAgent } = community(ada.pubkey, [ada, bea, cara]);
  const Tab = bestieTab(
    relay,
    host([], [ada, bea, cara]).agents,
    navigation,
    settingsCards,
  ).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  await user.click(screen.getByRole("button", { name: "Change" }));
  expect(await screen.findByRole("menuitem", { name: "Bea" })).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Cara" }));
  // One question: the replacement, with what a remote Bestie can't do.
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Cara your bestie?",
  });
  expect(confirmation).toHaveTextContent(
    "Your existing chats with Ada will still be available in your DMs. Some bestie features aren’t available with remote agents.",
  );
  expect(mainAgent.write).not.toHaveBeenCalled();
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Cara" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(cara.pubkey);
});

it("says nothing of remote agents when switching to one on this device", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const Tab = bestieTab(
    relay,
    host([]).agents,
    navigation,
    settingsCards,
  ).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  expect(confirmation).not.toHaveTextContent("remote");
});

it("shows a hosted Bestie's switches as unavailable when its provider has no instructions to edit, and saves nothing", async () => {
  const remote = {
    ...ada,
    place: "hosted",
    type: "block.builderlab/builderlab",
  } as Agent;
  const { relay } = community(ada.pubkey);
  const { agents, save } = host(["block.builderlab/builderlab"], [remote, bea]);
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  // Its instructions and timers are its provider's: nothing to switch here.
  expect(screen.getByText("Remembers you")).toBeVisible();
  expect(screen.queryAllByRole("switch")).toEqual([]);
  expect(
    screen.getAllByText("Not available with remote agents yet.").length,
  ).toBeGreaterThan(0);
  expect(save).not.toHaveBeenCalled();
  // It can still stop being Bestie.
  expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
});

/** A hosted Bestie whose provider holds `text`, read and replaced as its
 * provider's `get` and `set` do. */
const CHANGED_ELSEWHERE = "Its instructions were changed elsewhere.";
function hostedBestie(text: string) {
  let held = text;
  const get = vi.fn(async (_signal?: AbortSignal) => held);
  // As Agents does: replace only while the provider still holds `base`.
  const set = vi.fn(
    async (next: string, base: string, _signal?: AbortSignal) => {
      if (held !== base) throw new Error(CHANGED_ELSEWHERE);
      held = next;
    },
  );
  const remote = {
    ...ada,
    place: "hosted",
    type: "block.builderlab/builderlab",
  } as Agent;
  const { agents, save } = host(["block.builderlab/builderlab"], [remote, bea]);
  const hosted = { ...agents, hostedInstructions: () => ({ get, set }) };
  return {
    remote,
    agents: hosted,
    save,
    get,
    set,
    /** An edit saved through the provider's own settings or another device. */
    editElsewhere: (next: string) => {
      held = next;
    },
  };
}

it("shows a hosted Bestie's tab, not one on another device's", async () => {
  const { relay } = community(ada.pubkey);
  const tab = bestieTab(relay, host().agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  stop?.();
  expect(tab.when?.({ ...ada, place: "hosted" } as Agent)).toBe(true);
  expect(tab.when?.({ ...ada, place: "elsewhere" } as Agent)).toBe(false);
});

it("turns a hosted Bestie's memory on and off through its provider, and never touches attention", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { remote, agents, save, get, set } = hostedBestie("Be brief.");
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  expect(get).toHaveBeenCalledTimes(1);
  expect(remembers).not.toBeChecked();
  await user.click(remembers);
  await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  expect(set.mock.calls[0]?.[0]).toBe(withFeature("Be brief.", memory, true));
  // What the provider now holds is what the switch shows.
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked(),
  );
  expect(get).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
  expect(set.mock.calls[1]?.[0]).toBe("Be brief.");
  expect(save).not.toHaveBeenCalled();
  // Its timers never run here.
  for (const name of ["Hourly notes", "Dreaming"])
    expect(screen.queryByRole("switch", { name })).not.toBeInTheDocument();
  expect(
    screen.getAllByText("Not available with remote agents yet."),
  ).toHaveLength(2);
});

it("never replaces a hosted Bestie's instructions edited elsewhere since the tab read them", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { remote, agents, get, set, editElsewhere } = hostedBestie("Be brief.");
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  // The owner saves a restriction in the provider while the tab stays open.
  editElsewhere("Be brief. Never email anyone.");
  await user.click(remembers);
  expect(await screen.findByText(CHANGED_ELSEWHERE)).toBeVisible();
  expect(set).toHaveBeenCalledTimes(1);
  expect(await get.mock.results.at(-1)?.value).toBe(
    "Be brief. Never email anyone.",
  );
  // The switch now saves from the newer copy, keeping the owner's edit.
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked(),
  );
  expect(set.mock.calls.at(-1)?.[0]).toBe(
    withFeature("Be brief. Never email anyone.", memory, true),
  );
});

it("says why a hosted Bestie's instructions can't be read or saved, and lets either be tried again", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { remote, agents, get, set } = hostedBestie("Be brief.");
  get.mockRejectedValueOnce(new Error("Builderlab is down."));
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  expect(await screen.findByText("Builderlab is down.")).toBeVisible();
  expect(screen.queryByRole("switch")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  set.mockRejectedValueOnce(new Error("Instructions are too long."));
  await user.click(remembers);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Instructions are too long.",
  );
  expect(
    screen.getByRole("switch", { name: "Remembers you" }),
  ).not.toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked(),
  );
});

it("keeps Change unavailable while there is no other agent to choose", async () => {
  const { relay } = community(ada.pubkey, [ada]);
  const Tab = bestieTab(
    relay,
    host().agents,
    navigation,
    settingsCards,
  ).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
});

it("asks before making a remote former Bestie your Bestie again, and Cancel changes nothing", async () => {
  const user = userEvent.setup();
  // Saved none: there is no Bestie to replace.
  const { relay, mainAgent } = community(null);
  const remote = {
    ...ada,
    place: "elsewhere",
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const Tab = formerBestieTab(
    relay,
    host([], [bea, remote]).agents,
    navigation,
    settingsCards,
  ).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  const again = screen.getByRole("button", { name: "Make my Bestie again" });
  expect(again).toBeEnabled();
  await user.click(again);
  const ask = await screen.findByRole("alertdialog", {
    name: "Use Ada as your bestie?",
  });
  expect(ask).toHaveTextContent(
    "Some bestie features aren’t available with remote agents.",
  );
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mainAgent.write).not.toHaveBeenCalled();
  await user.click(again);
  await user.click(
    within(
      await screen.findByRole("alertdialog", {
        name: "Use Ada as your bestie?",
      }),
    ).getByRole("button", { name: "Use as bestie" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(ada.pubkey);
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("tells the host only when the Bestie or its community changes", async () => {
  const { relay, reconnect } = community(ada.pubkey);
  const tab = bestieTab(relay, host([]).agents, navigation, settingsCards);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  changed.mockClear();
  // Other view state in the community, such as a draft, isn't a change.
  writeView(SCOPE, "composer:draft", "hello");
  expect(changed).not.toHaveBeenCalled();
  // A new session in another community is.
  reconnect(`https://other.example:${OWNER}`);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(tab.when?.(ada)).toBe(false);
  stop?.();
});

it("turns memory on and off as a marked section of the instructions", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const base = { instructions: "head-1" };
  const agent = {
    ...ada,
    config: { model: "m", instructions: "Be brief." },
    configBase: base,
  } as Agent;
  const { rerender } = render(<Tab agent={agent} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  expect(remembers).not.toBeChecked();
  // The Memory tab only reads, so the row says how to clear a memory instead.
  expect(remembers).toHaveAccessibleDescription(
    "Adds memory rules to Bestie's instructions. Off removes them. Nothing Bestie remembered is deleted, and its core memory still goes into every prompt. To clear a memory, ask Bestie to forget it.",
  );
  expect(
    screen.getByText(/To clear a memory, ask Bestie to forget it\./),
  ).toBeVisible();

  await user.click(remembers);
  const on = withFeature("Be brief.", memory, true);
  // Revises the head the tab showed, keeping the rest of the config.
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { model: "m", instructions: on },
    base,
  });
  expect(on).toMatch(
    /^Be brief\.\n\n<!-- buzz:bestie\/memory v2 -->\n# Memory\n/,
  );

  // The saved instructions are what the switch shows.
  rerender(
    <Tab agent={{ ...agent, config: { model: "m", instructions: on } }} />,
  );
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked();
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { model: "m", instructions: "Be brief." },
    base,
  });
});

it("keeps memory on through the owner's edits, and offers Restore for edited markers", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const base = { instructions: "head-2" };
  const on = withFeature("Be brief.", memory, true);
  const close = "<!-- /buzz:bestie/memory -->";
  const shown = (instructions: string) =>
    ({ ...ada, config: { instructions }, configBase: base }) as Agent;
  // Typed below the section, which lands on its closing marker's line.
  const typed = `${on} Also French.`;
  const { rerender } = render(<Tab agent={shown(typed)} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  expect(remembers).toBeChecked();
  await user.click(remembers);
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { instructions: "Be brief.\n\nAlso French." },
    base,
  });

  // A closing marker edited by hand: no switch to add a second section.
  save.mockClear();
  const edited = on.replace(close, "<!-- /buzz:bestie/memory--> Also French.");
  rerender(<Tab agent={shown(edited)} />);
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  expect(screen.getByText(/edited where it starts or ends/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { instructions: `${on} Also French.` },
    base,
  });

  // With a marker gone, where the section ended is the owner's to say.
  rerender(<Tab agent={shown(on.replace(close, ""))} />);
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  expect(screen.getByText(/Fix its start and end lines there/)).toBeVisible();
  // Check-ins wait on memory.
  for (const name of ["Hourly notes", "Dreaming"])
    expect(screen.getByRole("switch", { name })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
});

it("says why a save failed and lets the switch be tried again", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  save.mockRejectedValueOnce(new Error("Connect to the community to save"));
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={{ ...ada, config: {} } as Agent} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  await user.click(remembers);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connect to the community to save",
  );
  expect(remembers).not.toBeChecked();
  expect(remembers).not.toHaveAttribute("aria-disabled", "true");
  // A config with no instructions yet gets the section alone.
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { instructions: withFeature("", memory, true) },
  });
});

it("offers no switch while the agent's instructions can't be read here", () => {
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(
    <Tab
      agent={
        {
          ...ada,
          config: {},
          configProblem: "This agent's instructions could not be read",
        } as Agent
      }
    />,
  );
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  // Each setting's row says why, check-ins too.
  expect(
    screen.getAllByText("This agent's instructions could not be read"),
  ).toHaveLength(3);
  expect(save).not.toHaveBeenCalled();
});

it("checks in only while memory is on, hourly and nightly apart, each as an Interest and a timer in the owner's DM", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const base = { instructions: "head-1" };
  const remembering = withFeature("Be brief.", memory, true);
  const off = {
    ...ada,
    config: { instructions: "Be brief." },
    configBase: base,
  };
  const { rerender } = render(<Tab agent={off as Agent} />);
  const hourly = () => screen.getByRole("switch", { name: "Hourly notes" });
  const nightly = () => screen.getByRole("switch", { name: "Dreaming" });
  // Memory is off, so check-ins can't be turned on.
  expect(hourly()).toHaveAttribute("aria-disabled", "true");
  expect(nightly()).toHaveAttribute("aria-disabled", "true");
  expect(screen.getAllByText("Turn on Remembers you first.")).toHaveLength(2);

  const on = { ...off, config: { instructions: remembering } } as Agent;
  rerender(<Tab agent={on} />);
  expect(hourly()).not.toBeChecked();
  await user.click(hourly());
  // The Interest and timer only: what every turn carries is left alone.
  expect(save).toHaveBeenCalledTimes(1);
  const [[, timers]] = save.mock.calls as [[string, AgentChange]];
  expect(timers.config).toBeUndefined();
  expect(timers.attention?.["interest/bestie-notes"]).toEqual({
    type: "interest",
    instructions: notes.timer?.interest,
  });
  expect(timers.attention?.["watch/bestie-notes"]).toMatchObject({
    type: "timer",
    interest_id: "bestie-notes",
    interval_secs: 3600,
    max_occurrences: null,
    expires_at: null,
    channel: DM,
    enabled: true,
  });
  // The objects are ones Attention accepts.
  for (const [slug, value] of Object.entries(timers.attention ?? {}))
    expect(validateObject(slug, value)).toBeUndefined();

  // On means the Interest and the timer are both there.
  const checking = {
    ...on,
    attention: {
      "interest/bestie-notes": { value: { type: "interest" } },
      "watch/bestie-notes": { value: { type: "timer", enabled: true } },
    },
  } as unknown as Agent;
  rerender(<Tab agent={checking} />);
  expect(hourly()).toBeChecked();
  // With Attention not running here, as while Watching is off, it says so.
  expect(screen.getByText(/^Paused: watches aren't running/)).toBeVisible();
  rerender(<Tab agent={{ ...checking, attentionEnabled: true } as Agent} />);
  expect(screen.queryByText(/^Paused/)).toBeNull();
  rerender(<Tab agent={{ ...checking, attention: {} } as Agent} />);
  expect(hourly()).not.toBeChecked();
  rerender(<Tab agent={checking} />);

  // Dreaming is its own switch: Hourly notes off leaves it alone.
  save.mockClear();
  rerender(<Tab agent={on} />);
  await user.click(nightly());
  expect(save).toHaveBeenCalledTimes(1);
  const [[, review]] = save.mock.calls as [[string, AgentChange]];
  expect(Object.keys(review.attention ?? {})).toEqual([
    "interest/bestie-dream",
    "watch/bestie-dream",
  ]);
  expect(review.attention?.["watch/bestie-dream"]).toMatchObject({
    interest_id: "bestie-dream",
    interval_secs: 86_400,
    channel: DM,
  });
  const dreamTimer = review.attention?.["watch/bestie-dream"] as
    | { armed_at: number }
    | undefined;
  expect(new Date((dreamTimer?.armed_at ?? 0) * 1000).getHours()).toBe(3);
  for (const [slug, value] of Object.entries(review.attention ?? {}))
    expect(validateObject(slug, value)).toBeUndefined();

  const both = {
    ...checking,
    attention: {
      ...checking.attention,
      "interest/bestie-dream": { value: { type: "interest" } },
      "watch/bestie-dream": { value: { type: "timer", enabled: true } },
    },
  } as unknown as Agent;
  rerender(<Tab agent={both} />);
  expect(hourly()).toBeChecked();
  expect(nightly()).toBeChecked();
  // Hourly notes off removes only its Interest and timer.
  save.mockClear();
  await user.click(hourly());
  expect(save.mock.calls).toEqual([
    [
      ada.key,
      {
        attention: {
          "interest/bestie-notes": null,
          "watch/bestie-notes": null,
        },
      },
    ],
  ]);
  // Memory off takes both with it, and leaves Attention's switch alone.
  save.mockClear();
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  expect(save.mock.calls).toEqual([
    [
      ada.key,
      {
        attention: {
          "interest/bestie-notes": null,
          "watch/bestie-notes": null,
          "interest/bestie-dream": null,
          "watch/bestie-dream": null,
        },
      },
    ],
    [ada.key, { config: { instructions: "Be brief." }, base }],
  ]);

  // Left on after memory went some other way, it can still be turned off.
  rerender(
    <Tab agent={{ ...both, config: { instructions: "Be brief." } } as Agent} />,
  );
  expect(hourly()).toBeChecked();
  expect(hourly()).not.toHaveAttribute("aria-disabled", "true");
});

/** Ada with memory on and check-ins off, ready to turn Hourly notes on. */
function remembering(attentionEnabled = false) {
  return {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
    attentionEnabled,
  } as Agent;
}
const TIMER = "watch/bestie-notes";
const INTEREST = "interest/bestie-notes";

it("says why a check-in couldn't be saved and lets its switch be tried again", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={remembering()} />);
  const hourly = screen.getByRole("switch", { name: "Hourly notes" });
  save.mockRejectedValueOnce(new Error("Connect to the community to save"));
  await user.click(hourly);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connect to the community to save",
  );
  expect(hourly).not.toBeChecked();
  expect(save).toHaveBeenCalledTimes(1);
  // Trying again saves it all again.
  save.mockClear();
  await user.click(hourly);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("offers to remove what is left of a check-in whose Interest or timer is gone", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const left = (slug: string, value: object) =>
    ({
      ...remembering(true),
      attention: { [slug]: { slug, value, modifiedAt: 1 } },
    }) as unknown as Agent;
  const { rerender } = render(
    <Tab agent={left(TIMER, { type: "timer", enabled: true })} />,
  );
  expect(
    screen.getByRole("switch", { name: "Hourly notes" }),
  ).not.toBeChecked();
  const remove = () =>
    screen.getByRole("button", {
      name: "Remove",
      description: "Hourly notes is partly saved",
    });
  await user.click(remove());
  expect(save.mock.calls[0]).toEqual([
    ada.key,
    { attention: { [TIMER]: null } },
  ]);
  // The same when the Interest is what is left, which holds the steps.
  save.mockClear();
  rerender(<Tab agent={left(INTEREST, { type: "interest" })} />);
  await user.click(remove());
  expect(save.mock.calls[0]).toEqual([
    ada.key,
    { attention: { [INTEREST]: null } },
  ]);
});

it("says a check-in paused in Attention is paused, and restarts it keeping its steps", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const paused = {
    ...remembering(true),
    attention: {
      [INTEREST]: { value: { type: "interest" } },
      [TIMER]: { value: { type: "timer", enabled: false } },
    },
  } as unknown as Agent;
  render(<Tab agent={paused} />);
  const hourly = screen.getByRole("switch", { name: "Hourly notes" });
  // Still on, so Off still removes it.
  expect(hourly).toBeChecked();
  expect(screen.getByText("Paused in Attention.")).toBeVisible();
  // Restart arms its timer again and leaves its Interest as it is; turning
  // it off and on would have deleted its steps.
  await user.click(screen.getByRole("button", { name: "Restart" }));
  const [key, change] = save.mock.calls[0] ?? [];
  expect(key).toBe(ada.key);
  expect(Object.keys(change?.attention ?? {})).toEqual([TIMER]);
  expect(change?.attention?.[TIMER]).toMatchObject({ enabled: true });
  expect(change?.restart).toEqual([TIMER]);
  expect(change?.attentionExpected).toEqual({
    [TIMER]: paused.attention[TIMER],
  });
  save.mockClear();
  await user.click(hourly);
  expect(save.mock.calls[0]).toEqual([
    ada.key,
    { attention: { [INTEREST]: null, [TIMER]: null } },
  ]);
});

it("shows a Former Bestie tab while a former Bestie has a setting on, with a way back", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(bea.pubkey);
  const tab = formerBestieTab(relay, host().agents, navigation, settingsCards);
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const stop = tab.subscribe?.(() => {});
  // Nobody is former before the account's choice is read.
  expect(tab.when?.(remembering)).toBe(false);
  await vi.waitFor(() => expect(tab.when?.(remembering)).toBe(true));
  // Not on the Bestie, nor on an agent with nothing on.
  expect(tab.when?.(bea)).toBe(false);
  expect(tab.when?.(ada)).toBe(false);

  const made = vi.fn();
  const stopMade = onBestieMade(made);
  const Tab = tab.component;
  render(<Tab agent={remembering} />);
  expect(
    screen.getByText("Ada is no longer your Bestie. These are still on."),
  ).toBeVisible();
  expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked();
  const hourly = screen.getByRole("switch", { name: "Hourly notes" });
  expect(hourly).toHaveAttribute("aria-disabled", "true");
  expect(screen.getAllByText("Only your Bestie checks in.")).toHaveLength(2);
  expect(screen.getByText("Private channels Ada can read")).toBeVisible();

  await user.click(
    screen.getByRole("button", { name: "Make my Bestie again" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Ada your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Ada" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(ada.pubkey);
  // This device made it Bestie, so the plugin hears of it.
  await vi.waitFor(() => expect(made).toHaveBeenCalledWith(ada.pubkey));
  await vi.waitFor(() => expect(tab.when?.(remembering)).toBe(false));
  stopMade();
  stop?.();
});

it("removes the Bestie after asking, and shows the agent as a Former Bestie", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  const agents = host().agents;
  const tab = bestieTab(relay, agents, navigation, settingsCards);
  const former = formerBestieTab(relay, agents, navigation, settingsCards);
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  expect(former.when?.(remembering)).toBe(false);
  const Tab = tab.component;
  render(<Tab agent={remembering} />);
  // A failed save says so and keeps the Bestie.
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  let ask = await screen.findByRole("alertdialog", {
    name: "Remove Ada as your Bestie?",
  });
  expect(ask).toHaveTextContent("Ada stays in Agents");
  expect(ask).toHaveTextContent("Its check-ins stop.");
  expect(ask).toHaveTextContent("memory rules and private channels stay");
  await user.click(
    within(ask).getByRole("button", { name: "Remove as Bestie" }),
  );
  expect(await within(ask).findByRole("alert")).toHaveTextContent(
    "Removing your Bestie couldn't be saved to your account. Try again.",
  );
  expect(tab.when?.(ada)).toBe(true);
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Remove" }));
  ask = await screen.findByRole("alertdialog", {
    name: "Remove Ada as your Bestie?",
  });
  await user.click(
    within(ask).getByRole("button", { name: "Remove as Bestie" }),
  );
  expect(mainAgent.write).toHaveBeenLastCalledWith(null);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(false));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // With no Bestie known, the agent with memory on is a Former Bestie.
  expect(former.when?.(remembering)).toBe(true);
  expect(former.when?.(bea)).toBe(false);
  stop?.();
});

it("shows a hosted former Bestie's Former Bestie tab while its memory is on, read from its provider", async () => {
  const user = userEvent.setup();
  const { relay } = community(bea.pubkey);
  const { remote, agents, get, set, save } = hostedBestie(
    withFeature("Be brief.", memory, true),
  );
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const listener = vi.fn();
  const stop = tab.subscribe?.(listener);
  // Its instructions aren't on this device until its provider is read.
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  expect(tab.when?.(remote)).toBe(false);
  // This device saw it as Bestie, so its provider is read for the tab.
  writeView(SCOPE, "bestie:former", [ada.pubkey]);
  const stopReading = readFormerHosted(relay, {
    ...agents,
    snapshot: () => ({ agents: [remote, bea] }),
    subscribe: () => () => {},
  } as unknown as Parameters<typeof readFormerHosted>[1]);
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(true));
  expect(get).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalled();
  // On another device, it isn't this device's to change.
  expect(tab.when?.({ ...remote, place: "elsewhere" } as Agent)).toBe(false);

  const Tab = tab.component;
  render(<Tab agent={remote} />);
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  expect(remembers).toBeChecked();
  await user.click(remembers);
  await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  expect(set.mock.calls[0]?.[0]).toBe("Be brief.");
  expect(save).not.toHaveBeenCalled();
  // With nothing left on, the tab goes.
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(false));
  stopReading();
  stop?.();
});

/** Reads a hosted former Bestie's provider in the background, as the plugin
 * does for each hosted agent this device saw as Bestie. */
function readInBackground(
  relay: RelayData,
  agents: ReturnType<typeof hostedBestie>["agents"],
  remote: Agent,
) {
  writeView(SCOPE, "bestie:former", [ada.pubkey]);
  return readFormerHosted(relay, {
    ...agents,
    snapshot: () => ({ agents: [remote, bea] }),
    subscribe: () => () => {},
  } as unknown as Parameters<typeof readFormerHosted>[1]);
}

it("keeps a hosted former Bestie's tab when an older background read ends after a newer save", async () => {
  const user = userEvent.setup();
  const { relay } = community(bea.pubkey);
  const { remote, agents, get } = hostedBestie("Be brief.");
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  // The background read starts while memory is off, and answers late.
  let answer = (_text: string) => {};
  get.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const stopReading = readInBackground(relay, agents, remote);
  expect(get).toHaveBeenCalledTimes(1);
  // Meanwhile the owner turns memory on, and the tab reads it back.
  const Tab = tab.component;
  render(<Tab agent={remote} />);
  await user.click(
    await screen.findByRole("switch", { name: "Remembers you" }),
  );
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(true));
  // The older answer, from before the save, changes nothing.
  answer("Be brief.");
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(tab.when?.(remote)).toBe(true);
  expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked();
  stopReading();
  stop?.();
});

it("keeps a hosted former Bestie's tab while a newer read is under way, whatever an older one answers", async () => {
  const { relay } = community(bea.pubkey);
  const { remote, agents } = hostedBestie("Be brief.");
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  // A failed read shows the tab, which reads again when it opens.
  startHostedRead(remote.pubkey).failed();
  expect(tab.when?.(remote)).toBe(true);
  const background = startHostedRead(remote.pubkey);
  const opened = startHostedRead(remote.pubkey);
  // The older read's "off" doesn't hide the tab and abort the newer read.
  background.read("Be brief.");
  expect(tab.when?.(remote)).toBe(true);
  // The newer read decides.
  opened.read("Be brief.");
  expect(tab.when?.(remote)).toBe(false);
  // A newer read abandoned lets the older one still under way count.
  startHostedRead(remote.pubkey).failed();
  const older = startHostedRead(remote.pubkey);
  startHostedRead(remote.pubkey).cancel();
  older.read("Be brief.");
  expect(tab.when?.(remote)).toBe(false);
  stop?.();
});

it("counts an older read's answer once a newer read is abandoned, from the moment it aborts", async () => {
  const { relay } = community(bea.pubkey);
  const { remote, agents } = hostedBestie("Be brief.");
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  const remembering = withFeature("Be brief.", memory, true);
  // The older read answers first, while the newer one is under way...
  const background = startHostedRead(remote.pubkey);
  const closing = new AbortController();
  const opened = startHostedRead(remote.pubkey, closing.signal);
  background.read(remembering);
  expect(tab.when?.(remote)).toBe(false);
  // ...and counts once the newer read is abandoned, without waiting for it.
  closing.abort();
  expect(tab.when?.(remote)).toBe(true);
  // What the abandoned read answers later changes nothing.
  opened.read("Be brief.");
  expect(tab.when?.(remote)).toBe(true);
  // Abandoned before the older read answers, the older read counts as it ends.
  const later = startHostedRead(remote.pubkey);
  const aborted = new AbortController();
  startHostedRead(remote.pubkey, aborted.signal);
  aborted.abort();
  later.read("Be brief.");
  expect(tab.when?.(remote)).toBe(false);
  stop?.();
});

it("shows a hosted former Bestie's tab from a background read that answers after the tab closed mid-read", async () => {
  const { relay } = community(bea.pubkey);
  const { remote, agents, get } = hostedBestie(
    withFeature("Be brief.", memory, true),
  );
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  let answer = (_text: string) => {};
  get.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const stopReading = readInBackground(relay, agents, remote);
  // The tab's own read never answers, as a provider ignoring the abort.
  get.mockImplementationOnce(() => new Promise<string>(() => {}));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={remote} />);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  unmount();
  answer(withFeature("Be brief.", memory, true));
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(true));
  stopReading();
  stop?.();
});

it("shows a Former Bestie tab for a hosted agent its provider holds no instructions for, while it is in a private channel", async () => {
  const { relay } = community(bea.pubkey);
  const remote = {
    ...ada,
    place: "hosted",
    type: "block.builderlab/builderlab",
  } as Agent;
  const { agents } = host(["block.builderlab/builderlab"], [remote, bea]);
  const { session } = relay.snapshot() as unknown as {
    session: { channels: { list: () => unknown } };
  };
  // One list per change, as a session's channel list is.
  const listed = (members: readonly string[]) => ({
    channels: [
      {
        id: "c1",
        name: "plans",
        channelType: "stream",
        private: true,
        members,
      },
    ],
  });
  let list = listed([OWNER, remote.pubkey]);
  session.channels.list = () => list;
  writeView(SCOPE, "bestie:former", [ada.pubkey]);
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(true));
  const Tab = tab.component;
  render(<Tab agent={remote} />);
  // Its memory can't be changed from here, but its channels can.
  expect(await screen.findByText("Remembers you")).toBeVisible();
  expect(screen.queryAllByRole("switch")).toEqual([]);
  expect(
    screen.getAllByText("Not available with remote agents yet.").length,
  ).toBeGreaterThan(0);
  expect(
    screen.getByRole("button", { name: "Remove Ada from #plans" }),
  ).toBeVisible();
  list = listed([OWNER]);
  expect(tab.when?.(remote)).toBe(false);
  stop?.();
});

it("keeps a hosted former Bestie's tab after a failed read, until a read shows nothing is on", async () => {
  const user = userEvent.setup();
  const { relay } = community(bea.pubkey);
  const { remote, agents, get } = hostedBestie("Be brief.");
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  get.mockRejectedValueOnce(new Error("Builderlab is down."));
  const stopReading = readInBackground(relay, agents, remote);
  // Nothing shows it has nothing on, so its tab stays to read again.
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(true));
  get.mockRejectedValueOnce(new Error("Builderlab is down."));
  const Tab = tab.component;
  render(<Tab agent={remote} />);
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("switch", { name: "Remembers you" }),
  ).not.toBeChecked();
  // A read that succeeds and shows nothing on lets the tab go.
  await vi.waitFor(() => expect(tab.when?.(remote)).toBe(false));
  stopReading();
  stop?.();
});

it("keeps a hosted former Bestie's tab when memory saved on but reading it back failed", async () => {
  const user = userEvent.setup();
  const { relay } = community(bea.pubkey);
  const { remote, agents, get, set } = hostedBestie("Be brief.");
  const tab = formerBestieTab(relay, agents, navigation, settingsCards);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(false));
  const Tab = tab.component;
  render(<Tab agent={remote} />);
  // Its first read finds memory off.
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  expect(tab.when?.(remote)).toBe(false);
  // Memory saves on, but reading it back fails.
  get.mockRejectedValueOnce(new Error("Builderlab is down."));
  await user.click(remembers);
  await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("Builderlab is down.")).toBeVisible();
  // The earlier off may be out of date, so the tab stays to read again.
  expect(tab.when?.(remote)).toBe(true);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("switch", { name: "Remembers you" }),
  ).toBeChecked();
  expect(tab.when?.(remote)).toBe(true);
  stop?.();
});

it("shows no Former Bestie tab while the account's choice is unread or unreadable", async () => {
  const { relay, mainAgent } = community(undefined);
  mainAgent.read.mockRejectedValueOnce(new Error("offline"));
  const former = formerBestieTab(
    relay,
    host().agents,
    navigation,
    settingsCards,
  );
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const stop = former.subscribe?.(() => {});
  await act(async () => {});
  expect(former.when?.(remembering)).toBe(false);
  stop?.();
});

it("shows a Former Bestie tab on an account that saved none, not on one with no record", async () => {
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  for (const [record, shows] of [
    [undefined, false],
    [null, true],
  ] as const) {
    const { relay, mainAgent } = community(record);
    const former = formerBestieTab(
      relay,
      host().agents,
      navigation,
      settingsCards,
    );
    const stop = former.subscribe?.(() => {});
    await act(async () => {});
    expect(mainAgent.read).toHaveBeenCalled();
    expect(former.when?.(remembering)).toBe(shows);
    stop?.();
    cleanup();
  }
});

it("offers no Remove without an account to save none to", async () => {
  const { relay } = community(undefined);
  // A device-only session would pick another agent at once.
  delete (relay.snapshot() as { session: { mainAgent?: unknown } }).session
    .mainAgent;
  setDefaultAgent(SCOPE, ada.pubkey);
  const Tab = bestieTab(
    relay,
    host().agents,
    navigation,
    settingsCards,
  ).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

it("lets a former Bestie's leftover check-in be turned off", async () => {
  const user = userEvent.setup();
  const { relay } = community(bea.pubkey);
  const { agents, save } = host();
  const Tab = formerBestieTab(
    relay,
    agents,
    navigation,
    settingsCards,
  ).component;
  const checking = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
    attention: {
      "interest/bestie-notes": {},
      "watch/bestie-notes": {},
    },
  } as unknown as Agent;
  render(<Tab agent={checking} />);
  const hourly = screen.getByRole("switch", { name: "Hourly notes" });
  expect(hourly).toBeChecked();
  expect(hourly).not.toHaveAttribute("aria-disabled", "true");
  await user.click(hourly);
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    attention: { "interest/bestie-notes": null, "watch/bestie-notes": null },
  });
});

const DREAM = "interest/bestie-dream";
const DREAM_TIMER = "watch/bestie-dream";
/** Ada with Dreaming on, its Interest holding `instructions`. */
function dreaming(instructions: string) {
  return {
    ...remembering(true),
    attention: {
      [DREAM]: {
        slug: DREAM,
        value: { type: "interest", instructions },
        modifiedAt: 1,
      },
      [DREAM_TIMER]: {
        slug: DREAM_TIMER,
        value: { type: "timer", enabled: true },
        modifiedAt: 1,
      },
    },
  } as unknown as Agent;
}
const dreamV2 = dream.timer?.earlier?.[2] ?? "";
const ownLines = "OWNER NOTES. Keep replies under five lines.";

it("offers Dreaming's new version, and saves it only when asked, with a way back", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const old = dreaming(dreamV2);
  const { rerender } = render(<Tab agent={old} />);
  // Showing the update saves nothing.
  expect(
    screen.getByText(`Version ${dream.version} of Dreaming is ready`),
  ).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "See changes" }));
  expect(
    await screen.findByRole("dialog", {
      name: `Dreaming: version 2 → ${dream.version}`,
    }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: `Update to version ${dream.version}` }),
  );
  // Only the Interest, and only if it is still the one shown.
  expect(save.mock.calls[0]).toEqual([
    ada.key,
    {
      attention: {
        [DREAM]: { type: "interest", instructions: interestText(dream) },
      },
      attentionExpected: { [DREAM]: old.attention[DREAM] },
    },
  ]);
  const updated = dreaming(interestText(dream));
  rerender(<Tab agent={updated} />);
  expect(
    screen.queryByText(`Version ${dream.version} of Dreaming is ready`),
  ).toBeNull();
  // Undo puts version 2 back.
  save.mockClear();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(save.mock.calls[0]?.[1].attention).toEqual({
    [DREAM]: { type: "interest", instructions: dreamV2 },
  });
});

it("hides Dreaming's update for now with Later, and keeps a way to review it", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={dreaming(dreamV2)} />);
  await user.click(screen.getByRole("button", { name: "Later" }));
  expect(
    screen.queryByText(`Version ${dream.version} of Dreaming is ready`),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(
    screen.getByText(`Version ${dream.version} of Dreaming is ready`),
  ).toBeVisible();
  expect(save).not.toHaveBeenCalled();
});

it("puts a new version's buttons on their own line below what it changes", () => {
  const { relay } = community(ada.pubkey);
  const { agents } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={dreaming(dreamV2)} />);
  const title = `Version ${dream.version} of Dreaming is ready`;
  const offer = screen.getByRole("group", { name: title });
  // The row keeps the full width for its title and summary.
  const row = within(offer).getByText(title).closest(".buzz-preference-row");
  expect(row?.querySelector(".buzz-preference-row-trailing")).toBeNull();
  for (const name of ["Later", "See changes", "Update"]) {
    const button = within(offer).getByRole("button", { name });
    expect(row?.contains(button)).toBe(false);
    const position = row?.compareDocumentPosition(button) ?? 0;
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

it("shows Dreaming set up by hand as one line with Review, and a saved version with Undo below it", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const original = `${dreamV2}\n\n${ownLines}`;
  const own = dreaming(original);
  const { rerender } = render(<Tab agent={own} />);
  const line = (title: string) =>
    screen.getByText(title).closest(".buzz-preference-row") as HTMLElement;
  const customized = line(`Customized · version ${dream.version} available`);
  // Its one action is beside it; Keep as is is in its dialog.
  expect(
    within(customized).getByRole("button", { name: "Review" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Keep as is" })).toBeNull();
  expect(screen.queryByText(/set up by hand/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Closest to version 2.")).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Keep as is" }),
  ).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", {
      name: `Use version ${dream.version}`,
    }),
  );
  rerender(<Tab agent={dreaming(`${interestText(dream)}\n\n${ownLines}`)} />);
  const today = new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const saved = line(`Saved version ${dream.version} · ${today}`);
  expect(
    within(saved).getByText("The text before is kept on this device."),
  ).toBeVisible();
  expect(within(saved).getByRole("button", { name: "Undo" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  // Undo puts the original back, word for word.
  save.mockClear();
  await user.click(within(saved).getByRole("button", { name: "Undo" }));
  expect(save.mock.calls[0]?.[1].attention).toEqual({
    [DREAM]: { type: "interest", instructions: original },
  });
  // Undone, it is customized again with Review, and its own row can put
  // back the text from before the Undo.
  rerender(<Tab agent={own} />);
  const again = line(`Customized · version ${dream.version} available`);
  expect(within(again).getByRole("button", { name: "Review" })).toBeVisible();
  expect(
    within(again).queryByRole("button", { name: /Undo|Restore/ }),
  ).toBeNull();
  const undone = line(`Undid version ${dream.version} · ${today}`);
  expect(
    within(undone).getByText(
      "The text before the Undo is kept on this device.",
    ),
  ).toBeVisible();
  expect(
    within(undone).getByRole("button", { name: "Restore previous text" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByText(/^Saved /)).toBeNull();
});

it("puts back lines added after a new version, from the row an Undo leaves", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const added = "ADDED LATER. Mention the weather.";
  for (const [before, take, change] of [
    // Adopted from steps set up by hand, then a line added after them.
    [
      `${dreamV2}\n\n${ownLines}`,
      "Review",
      (text: string) => `${text}\n\n${added}`,
    ],
    // Updated from version 2 as shipped, then one of its steps edited.
    [
      dreamV2,
      "See changes",
      (text: string) => text.replace("1. READ.", "1. READ, slowly."),
    ],
  ] as const) {
    localStorage.clear();
    save.mockClear();
    const { rerender, unmount } = render(<Tab agent={dreaming(before)} />);
    await user.click(screen.getByRole("button", { name: take }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", {
        name:
          take === "Review"
            ? `Use version ${dream.version}`
            : `Update to version ${dream.version}`,
      }),
    );
    const saved = save.mock.calls[0]?.[1].attention?.[DREAM];
    expect(saved?.type).toBe("interest");
    const updated = (saved as { instructions: string }).instructions;
    const edited = change(updated);
    expect(edited).not.toBe(updated);
    // The owner changes it, then undoes the update anyway.
    rerender(<Tab agent={dreaming(edited)} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Undo anyway",
      }),
    );
    expect(save.mock.calls[1]?.[1].attention).toEqual({
      [DREAM]: { type: "interest", instructions: before },
    });
    // The offer is back, and the row the Undo left puts the added line back.
    rerender(<Tab agent={dreaming(before)} />);
    await user.click(
      screen.getByRole("button", { name: "Restore previous text" }),
    );
    expect(save.mock.calls[2]?.[1].attention).toEqual({
      [DREAM]: { type: "interest", instructions: edited },
    });
    unmount();
  }
});

it("keeps Dreaming set up by hand, or with a changed start or end line, as is once the owner says so", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const hiddenTitle = `Version ${dream.version} of Dreaming is available`;
  for (const [text, title] of [
    [
      `${dreamV2}\n\n${ownLines}`,
      `Customized · version ${dream.version} available`,
    ],
    [
      `<!-- buzz:bestie/dream.nightly v2 -->\n${dreamV2}\n\n${ownLines}`,
      `Start or end line changed · version ${dream.version} available`,
    ],
  ] as const) {
    localStorage.clear();
    // Kept as is before this layout, which saved the same choice.
    new Receipts(SCOPE, ada.key).hide(dream.id, dream.version, false);
    const old = render(<Tab agent={dreaming(text)} />);
    expect(screen.getByText(hiddenTitle)).toBeVisible();
    expect(screen.queryByText(title)).toBeNull();
    old.unmount();
    // Kept as is from the dialog: it stays hidden when the tab opens again.
    localStorage.clear();
    const first = render(<Tab agent={dreaming(text)} />);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Keep as is",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(hiddenTitle)).toBeVisible();
    first.unmount();
    render(<Tab agent={dreaming(text)} />);
    expect(screen.getByText(hiddenTitle)).toBeVisible();
    expect(screen.queryByText(title)).toBeNull();
    // Review shows the offer again.
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(title)).toBeVisible();
    cleanup();
  }
  expect(save).not.toHaveBeenCalled();
});

it("adopts a Dreaming set up by hand as version 3 with the lines it chose to keep", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={dreaming(`${dreamV2}\n\n${ownLines}`)} />);
  expect(
    screen.getByText(`Customized · version ${dream.version} available`),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Review" }));
  const kept = await screen.findByRole("checkbox", { name: ownLines });
  expect(kept).toBeChecked();
  // Unchecked, it stays only in the backup; checked again, it is kept.
  await user.click(kept);
  expect(kept).not.toBeChecked();
  await user.click(kept);
  expect(kept).toBeChecked();
  await user.click(
    screen.getByRole("button", { name: `Use version ${dream.version}` }),
  );
  expect(save.mock.calls[0]?.[1].attention).toEqual({
    [DREAM]: {
      type: "interest",
      instructions: `${interestText(dream)}\n\n${ownLines}`,
    },
  });
});

it("offers Dreaming whose closing line was deleted the way it offers one set up by hand, showing the result first", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(
    <Tab
      agent={dreaming(
        `<!-- buzz:bestie/dream.nightly v2 -->\n${dreamV2}\n\n${ownLines}`,
      )}
    />,
  );
  expect(
    screen.getByText(
      `Start or end line changed · version ${dream.version} available`,
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  // What it will be, whole, before it is saved.
  expect(
    within(dialog).getByText(
      `Now → version ${dream.version} with the lines you keep`,
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("checkbox", { name: ownLines }),
  ).toBeChecked();
  await user.click(
    screen.getByRole("button", { name: `Use version ${dream.version}` }),
  );
  expect(save.mock.calls[0]?.[1].attention).toEqual({
    [DREAM]: {
      type: "interest",
      instructions: `${interestText(dream)}\n\n${ownLines}`,
    },
  });
});

it("saves nothing from a dialog whose Interest changed after it opened, and closes it to review the latest", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const { rerender } = render(<Tab agent={dreaming(dreamV2)} />);
  for (const [latest, row] of [
    // The agent adds the owner's notes: Review, not Update, keeps them.
    [
      `${dreamV2}\n\n${ownLines}`,
      `Customized · version ${dream.version} available`,
    ],
    // A newer Buzz set it: nothing to do here.
    [
      "<!-- buzz:bestie/dream.nightly v4 -->\nSteps from a newer Buzz.\n<!-- /buzz:bestie/dream.nightly -->",
      "Dreaming is version 4",
    ],
  ] as const) {
    rerender(<Tab agent={dreaming(dreamV2)} />);
    await user.click(screen.getByRole("button", { name: "See changes" }));
    const dialog = await screen.findByRole("dialog");
    rerender(<Tab agent={dreaming(latest)} />);
    expect(
      within(dialog).getByText(
        /changed after this opened, so this can't be saved/,
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: `Update to version ${dream.version}`,
      }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByRole("button", { name: "Show the latest" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(row)).toBeVisible();
  }
  expect(save).not.toHaveBeenCalled();
});

it("says inside the dialog why a save was refused, keeping it open", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  save.mockRejectedValueOnce(
    new Error("Attention changed. Review it and try again."),
  );
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={dreaming(dreamV2)} />);
  await user.click(screen.getByRole("button", { name: "See changes" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(
    within(dialog).getByRole("button", {
      name: `Update to version ${dream.version}`,
    }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Attention changed. Review it and try again.",
  );
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("opens a dialog without the alert of a save that failed before it", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  save.mockRejectedValueOnce(
    new Error("Attention changed. Review it and try again."),
  );
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  render(<Tab agent={dreaming(dreamV2)} />);
  // Update from the row fails, and says so beside it.
  await user.click(screen.getByRole("button", { name: "Update" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Attention changed. Review it and try again.",
  );
  await user.click(screen.getByRole("button", { name: "See changes" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(
    screen.queryByText("Attention changed. Review it and try again."),
  ).toBeNull();
});

it("offers nothing to do to a Dreaming a newer Buzz set, not even Undo", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents, navigation, settingsCards).component;
  const { rerender } = render(<Tab agent={dreaming(dreamV2)} />);
  await user.click(screen.getByRole("button", { name: "Update" }));
  rerender(<Tab agent={dreaming(interestText(dream))} />);
  expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
  rerender(
    <Tab
      agent={dreaming(
        "<!-- buzz:bestie/dream.nightly v4 -->\nSteps from a newer Buzz.\n<!-- /buzz:bestie/dream.nightly -->",
      )}
    />,
  );
  expect(screen.getByText("Dreaming is version 4")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});
