import {
  createContext,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComposerSession } from "./composer-session";
import { useListedChannel } from "../relay/listed-channel";
import { useProfileGeneration } from "../relay/react";

export type MessageStyle = "bubbles" | "agents";
/** How a conversation's rows present: viewer-aligned bubbles, or every row
 * laid out as a received, unfilled message, optionally keeping the viewer's
 * own bubble colour. */
export type BubbleLayout = "bubbles" | "unboxed" | "unboxed-own-color";
export const BubblePresentation = createContext<BubbleLayout>("bubbles");
/** The layout for a thread with a person in it, where the conversation's own
 * layout must not decide it: absent unless bubbles are only with agents. */
export const PersonThreadLayout = createContext<BubbleLayout | undefined>(
  undefined,
);

/** One device-local choice with save recovery: the active value survives a
 * failed write until a later save or another window's change replaces it. */
function devicePreference<T extends string>(
  key: string,
  parse: (saved: string | null) => T,
) {
  const changed = `${key}-changed`;
  let unsaved: T | undefined;
  const read = (): T => {
    if (unsaved !== undefined) return unsaved;
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  };
  const subscribe = (listener: () => void) => {
    const storage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      unsaved = undefined;
      listener();
    };
    window.addEventListener(changed, listener);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(changed, listener);
      window.removeEventListener("storage", storage);
    };
  };
  return {
    read,
    useValue: () => useSyncExternalStore(subscribe, read),
    useUnsaved: () =>
      useSyncExternalStore(subscribe, () => unsaved !== undefined),
    set(value: T) {
      unsaved = value;
      try {
        localStorage.setItem(key, value);
        unsaved = undefined;
      } catch {
        // Retain the active choice and its recovery state across settings remounts.
      }
      window.dispatchEvent(new Event(changed));
    },
  };
}

const style = devicePreference<MessageStyle>(
  "buzz-message-style.v1",
  (saved) => (saved === "agents" ? "agents" : "bubbles"),
);
const ownColor = devicePreference<"on" | "off">(
  "buzz-message-own-color.v1",
  (saved) => (saved === "on" ? "on" : "off"),
);

/** Bubbles remain the default. */
export const messageStylePreference = style.read;
export const useMessageStyle = style.useValue;
export const setMessageStylePreference = style.set;
export function useMessageStylePreference() {
  return { style: style.useValue(), unsaved: style.useUnsaved() };
}
/** Where bubbles are off, the viewer's own messages keep theirs. Off by default. */
export const ownColorPreference = () => ownColor.read() === "on";
export const useOwnColor = () => ownColor.useValue() === "on";
export const setOwnColorPreference = (on: boolean) =>
  ownColor.set(on ? "on" : "off");
export function useOwnColorPreference() {
  return { ownColor: useOwnColor(), unsaved: ownColor.useUnsaved() };
}

const dmBubbles = devicePreference<"on" | "off">(
  "buzz-message-dm-bubbles.v1",
  (saved) => (saved === "off" ? "off" : "on"),
);
/** With bubbles only with agents, direct messages keep bubbles. On by default. */
export const dmBubblesPreference = () => dmBubbles.read() === "on";
export const useDmBubbles = () => dmBubbles.useValue() === "on";
export const setDmBubblesPreference = (on: boolean) =>
  dmBubbles.set(on ? "on" : "off");
export function useDmBubblesPreference() {
  return { dmBubbles: useDmBubbles(), unsaved: dmBubbles.useUnsaved() };
}

/** Chats with only agents besides the viewer stay bubbles even in lists. A
 * larger roster is not treated as one, so it never loads every member. */
export const AGENTS_ONLY_LIMIT = 20;

/** A thread's own authors, whoever else belongs to its channel. */
export function threadAuthors(
  rows: readonly Readonly<{
    authorId: string;
    workflowOwnerId?: string | undefined;
    membership?: unknown;
  }>[],
): readonly string[] {
  return [
    ...new Set(
      rows
        .filter((row) => !row.membership)
        .map((row) => row.workflowOwnerId ?? row.authorId),
    ),
  ];
}

/** Whether this channel's roster is the viewer and only known agents, from
 * the same evidence as agent avatars. A member not yet known as an agent counts
 * as a person. Reads nothing unless enabled, and loads profiles only for a
 * roster small enough to qualify. */
export function useAgentsOnlyChat(
  session: ComposerSession,
  channelId: string,
  enabled: boolean,
): boolean {
  const members = useListedChannel(
    enabled ? session.channels : undefined,
    channelId,
    (channel) => channel?.members,
  );
  const others =
    session.viewer &&
    members?.includes(session.viewer) &&
    members.length - 1 <= AGENTS_ONLY_LIMIT
      ? members.filter((key) => key !== session.viewer).join(",")
      : "";
  const ownPending = useOwnAgentsPending(session, !!others);
  const answer = (): "agents" | "people" => {
    if (!others) return "people";
    const profiles = session.profiles.snapshot();
    const library = session.agentChoices.snapshot()?.identities ?? [];
    // Per member rather than knownAgentPubkeys: this runs on every profile
    // change, and the profile cache is far larger than a capped roster.
    return others
      .split(",")
      .every(
        (key) =>
          !!profiles.get(key)?.isAgent ||
          library.some((identity) => identity.pubkey === key),
      )
      ? "agents"
      : "people";
  };
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!others) return () => {};
      const profiles = session.profiles.subscribe(listener);
      const library = session.agentChoices.subscribe(listener);
      return () => {
        profiles();
        library();
      };
    },
    [others, session],
  );
  const roster = useSyncExternalStore(subscribe, answer);
  const generation = useProfileGeneration(
    others ? session.profiles : undefined,
  );
  useEffect(() => {
    void generation;
    if (!others) return;
    void session.profiles
      .ensure(others.split(","), "background")
      .catch(() => {});
  }, [others, session, generation]);
  // The first answer holds until the members change, so an agent learned
  // later applies on the next visit instead of reflowing this one.
  const visit = `${channelId}\n${others}`;
  const decided =
    others && (roster === "agents" || !ownPending)
      ? roster === "agents"
      : undefined;
  const [held, hold] =
    useState<Readonly<{ visit: string; agentsOnly: boolean }>>();
  if (held?.visit !== visit && (held || decided !== undefined))
    hold(decided === undefined ? undefined : { visit, agentsOnly: decided });
  return held?.visit === visit ? held.agentsOnly : roster === "agents";
}

/** Whether the viewer's own agents are still loading, demanding them while
 * enabled, so a chat with one isn't decided before they arrive. */
export function useOwnAgentsPending(
  session: ComposerSession,
  enabled: boolean,
): boolean {
  const source = session.agentChoices;
  useEffect(() => {
    if (!enabled) return;
    const release = source.retain();
    source.ensure();
    return release;
  }, [enabled, source]);
  return useSyncExternalStore(
    enabled ? source.subscribe : noSubscription,
    () => enabled && !!source.snapshot()?.pending,
  );
}

const noSubscription = () => () => {};

/** The thread a thread pane shows, by opened message and root, and the layout
 * it first settled on, so live replies, a late root or a remount don't reflow
 * it. Showing another thread forgets it. */
export type ThreadVisit = Readonly<{
  layout(keys: readonly string[]): boolean | undefined;
  show(keys: readonly string[], bubbles: boolean | undefined): void;
}>;
export function threadVisit(): ThreadVisit {
  let visit:
    | Readonly<{ keys: readonly string[]; bubbles: boolean | undefined }>
    | undefined;
  return {
    layout(keys) {
      const current = visit;
      return current && keys.some((key) => current.keys.includes(key))
        ? current.bubbles
        : undefined;
    },
    show(keys, bubbles) {
      visit = { keys, bubbles };
    },
  };
}
export const ThreadVisit = createContext<ThreadVisit>({
  layout: () => undefined,
  show: () => {},
});
