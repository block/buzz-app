// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, expect, it } from "vitest";
import {
  BubblePresentation,
  PersonThreadLayout,
  setMessageStylePreference,
  setDmBubblesPreference,
  setOwnColorPreference,
} from "../messages/message-bubbles";
import type { ChannelList, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { ConversationChannel } from "./Conversation";

const viewer = "a".repeat(64);
const person = "b".repeat(64);
const agent = "c".repeat(64);

afterEach(() => {
  cleanup();
  setMessageStylePreference("bubbles");
  setOwnColorPreference(false);
  setDmBubblesPreference(true);
  localStorage.clear();
});

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function fixture(
  members: readonly string[],
  {
    profiles: initialProfiles = [
      [viewer, { name: "Reader" }],
      [person, { name: "Teammate" }],
      [agent, { name: "Bot", isAgent: true }],
    ],
    library = [],
  }: {
    profiles?: [string, Profile][];
    library?: string[];
  } = {},
) {
  const list = store<ChannelList>({
    status: "ready",
    channels: [
      { id: "c", name: "Chat", members },
      { id: "people", name: "People", members: [viewer, person] },
    ],
  });
  const profiles = store<ReadonlyMap<string, Profile>>(
    new Map(initialProfiles),
  );
  const choices = store<{
    pending?: boolean;
    identities: { pubkey: string }[];
  }>({ identities: library.map((pubkey) => ({ pubkey })) });
  const demanded: string[] = [];
  const ensured: string[][] = [];
  let generation = 0;
  const session = {
    viewer,
    channels: { list: list.snapshot, subscribeList: list.subscribe },
    profiles: {
      snapshot: profiles.snapshot,
      subscribe: profiles.subscribe,
      ensure: async (ids: string[]) => {
        ensured.push(ids);
      },
      generation: () => generation,
    },
    agentChoices: {
      snapshot: choices.snapshot,
      subscribe: choices.subscribe,
      retain: () => {
        demanded.push("retain");
        return () => demanded.push("release");
      },
      ensure: () => demanded.push("ensure"),
    },
    unread: {
      enterChannel: async () => {},
      leaveChannel: () => {},
    },
  } as unknown as RelaySession;
  const purge = () => {
    generation++;
    profiles.set(new Map());
  };
  return { list, profiles, choices, ensured, demanded, session, purge };
}

function Probe() {
  return (
    <>
      <output aria-label="Bubbles">{useContext(BubblePresentation)}</output>
      <output aria-label="Person threads">
        {useContext(PersonThreadLayout) ?? "conversation"}
      </output>
    </>
  );
}

function page(session: RelaySession, id = "c", channelType?: "dm" | "stream") {
  return (
    <ConversationChannel
      session={session}
      scope={`https://fixture.test:${viewer}`}
      extensions={{} as never}
      channel={{ id, name: "Chat", channelType }}
      interactions={{
        onOpenLink: () => true,
        canOpenLink: () => false,
        onOpenMediaReview: () => {},
      }}
    >
      <Probe />
    </ConversationChannel>
  );
}

it("keeps bubbles by default without loading profiles or agents", () => {
  const { ensured, demanded, session } = fixture([viewer, person, agent]);
  render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  expect(ensured).toEqual([]);
  expect(demanded).toEqual([]);
});

it("keeps bubbles in a list only while the roster is the viewer and agents", () => {
  setMessageStylePreference("agents");
  const { list, session } = fixture([viewer, agent]);
  render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  act(() =>
    list.set({
      status: "ready",
      channels: [{ id: "c", name: "Chat", members: [viewer, agent, person] }],
    }),
  );
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  act(() => setMessageStylePreference("bubbles"));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
});

it("turns bubbles off between people", () => {
  setMessageStylePreference("agents");
  render(page(fixture([viewer, person]).session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
});

it("counts a library agent, and an agent whose profile loads later from the next visit", () => {
  setMessageStylePreference("agents");
  render(
    page(fixture([viewer, agent], { profiles: [], library: [agent] }).session),
  );
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  cleanup();
  const { profiles, ensured, session } = fixture([viewer, agent], {
    profiles: [],
  });
  render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  expect(ensured).toEqual([[agent]]);
  act(() => profiles.set(new Map([[agent, { name: "Bot", isAgent: true }]])));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  cleanup();
  render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
});

it("keeps bubbles with several agents, and keeps own color when asked", () => {
  setMessageStylePreference("agents");
  const other = "d".repeat(64);
  render(
    page(
      fixture([viewer, agent, other], {
        profiles: [
          [agent, { name: "Bot", isAgent: true }],
          [other, { name: "Bot 2", isAgent: true }],
        ],
      }).session,
    ),
  );
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  cleanup();
  render(page(fixture([viewer, person]).session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  act(() => setOwnColorPreference(true));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(
    "unboxed-own-color",
  );
});

it("follows a channel switch, and holds its layout while a purge reloads the agent", () => {
  setMessageStylePreference("agents");
  const { ensured, purge, session } = fixture([viewer, agent]);
  const view = render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  view.rerender(page(session, "people"));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  view.rerender(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  const before = ensured.length;
  act(() => purge());
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  expect(ensured.slice(before)).toEqual([[agent]]);
});

it("does not count a profile that says it is not an agent", () => {
  setMessageStylePreference("agents");
  render(
    page(
      fixture([viewer, person], {
        profiles: [[person, { name: "Teammate" }]],
      }).session,
    ),
  );
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
});

it("keeps bubbles in direct messages with people unless turned off", () => {
  setMessageStylePreference("agents");
  const { session } = fixture([viewer, person]);
  const view = render(page(session, "c", "dm"));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  act(() => setDmBubblesPreference(false));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  view.rerender(page(session, "c", "stream"));
  act(() => setDmBubblesPreference(true));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
});

it("keeps bubbles with as many agents as the roster limit", () => {
  setMessageStylePreference("agents");
  const crowd = Array.from({ length: 20 }, (_, i) =>
    (i + 10).toString(16).padStart(64, "0"),
  );
  render(page(fixture([viewer, ...crowd], { library: crowd }).session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
});

it("never loads profiles for a roster too large to be agents only", () => {
  setMessageStylePreference("agents");
  const crowd = Array.from({ length: 21 }, (_, i) =>
    (i + 10).toString(16).padStart(64, "0"),
  );
  const { ensured, session } = fixture([viewer, ...crowd], {
    library: crowd,
  });
  render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  expect(ensured).toEqual([]);
});

it("decides again when the roster changes", () => {
  setMessageStylePreference("agents");
  const stranger = "e".repeat(64);
  const { list, session } = fixture([viewer, agent]);
  render(page(session));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  act(() =>
    list.set({
      status: "ready",
      channels: [{ id: "c", name: "Chat", members: [viewer, agent, stranger] }],
    }),
  );
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
});

it("loads the viewer's own agents, and decides only once they have loaded", () => {
  setMessageStylePreference("agents");
  const { choices, demanded, session } = fixture([viewer, agent], {
    profiles: [],
  });
  choices.set({ pending: true, identities: [] });
  render(page(session));
  expect(demanded).toEqual(["retain", "ensure"]);
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
  act(() => choices.set({ identities: [{ pubkey: agent }] }));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  act(() => choices.set({ identities: [] }));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
});

it("decides again after a conversation without a roster check, or a style change", () => {
  setMessageStylePreference("agents");
  const crowd = Array.from({ length: 21 }, (_, i) =>
    (i + 10).toString(16).padStart(64, "0"),
  );
  for (const between of ["dm", "crowd", "style"] as const) {
    const { list, profiles, session } = fixture([viewer, agent], {
      profiles: [],
    });
    list.set({
      status: "ready",
      channels: [
        { id: "c", name: "Chat", members: [viewer, agent] },
        { id: "people", name: "People", members: [viewer, ...crowd] },
      ],
    });
    const view = render(page(session));
    expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
    act(() => profiles.set(new Map([[agent, { name: "Bot", isAgent: true }]])));
    expect(screen.getByLabelText("Bubbles")).toHaveTextContent(/^unboxed$/);
    if (between === "style") {
      act(() => setMessageStylePreference("bubbles"));
      act(() => setMessageStylePreference("agents"));
    } else
      view.rerender(
        between === "dm"
          ? page(session, "people", "dm")
          : page(session, "people"),
      );
    view.rerender(page(session));
    expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
    cleanup();
  }
});

it("lists threads with people in them unless bubbles are everywhere or kept in this DM", () => {
  const threads = () => screen.getByLabelText("Person threads");
  const { session } = fixture([viewer, agent]);
  const view = render(page(session));
  expect(threads()).toHaveTextContent("conversation");
  act(() => setMessageStylePreference("agents"));
  expect(screen.getByLabelText("Bubbles")).toHaveTextContent("bubbles");
  expect(threads()).toHaveTextContent(/^unboxed$/);
  act(() => setOwnColorPreference(true));
  expect(threads()).toHaveTextContent("unboxed-own-color");
  view.rerender(page(session, "c", "dm"));
  expect(threads()).toHaveTextContent("conversation");
  act(() => setDmBubblesPreference(false));
  expect(threads()).toHaveTextContent("unboxed-own-color");
});
