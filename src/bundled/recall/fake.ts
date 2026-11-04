// A fake turn and fake deps for tests: everything recall touches, nothing it does not.
import {
  DEFAULT_SETTINGS,
  type Deps,
  type Event,
  type Settings,
  type Turn,
  type TurnReads,
} from "./types.ts";

export const AGENT = "a".repeat(64);
export const OWNER = "0".repeat(64);
export const CHANNEL = "c-here";

export function turn(
  over: Partial<Turn> = {},
  reads: Partial<TurnReads> = {},
): Turn {
  return {
    agent: AGENT,
    community: "wss://relay.test",
    owner: OWNER,
    channel: CHANNEL,
    event: "e".repeat(64),
    text: "",
    deadline: 3_000,
    reads: {
      events: async () => [],
      channel: async () => undefined,
      memories: async () => ({ entries: [], partial: false }),
      ...reads,
    },
    ...over,
  };
}

export function deps(
  over: Partial<Omit<Deps, "settings">> & { settings?: Partial<Settings> } = {},
): Deps {
  const { settings, ...rest } = over;
  return {
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    decide: async () => ({
      outcome: "failed",
      backend: undefined,
      reason: "unavailable",
    }),
    now: () => 0,
    ...rest,
  };
}

export function message(
  id: string,
  content: string,
  over: Partial<Event> = {},
): Event {
  return {
    id,
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    content,
    tags: [["h", CHANNEL]],
    ...over,
  };
}
