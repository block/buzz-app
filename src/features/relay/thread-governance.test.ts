import { describe, expect, it } from "vitest";
import type { EventData, RelayEvent } from "./events";
import type { Outbox, OutgoingEvent } from "./outbox";
import type { ProfileQueries } from "./profile-directory";
import type { RelayReader } from "./reader";
import { SessionControls } from "../agent-harness/session-control";
import {
  createThreadGovernance,
  foldThreadGovernance,
  THREAD_GOVERNANCE_KIND,
} from "./thread-governance";

const agent = "a".repeat(64);
const owner = "b".repeat(64);
const channel = "11111111-1111-4111-8111-111111111111";
const rootA = "d".repeat(64);
const rootB = "e".repeat(64);

function event(
  id: number,
  input: Partial<EventData> & Pick<EventData, "kind" | "tags">,
): EventData {
  return {
    id: id.toString(16).padStart(64, "0"),
    pubkey: agent,
    created_at: id,
    content: "",
    ...input,
  };
}

function completion(id: number, root = rootA) {
  return event(id, {
    kind: THREAD_GOVERNANCE_KIND,
    pubkey: owner,
    content: JSON.stringify({ version: 1, agent }),
    tags: [
      ["h", channel],
      ["e", root, "", "root"],
      ["type", "buzz.thread-governance/v1"],
      ["action", "completed"],
    ],
  });
}

describe("thread governance fold", () => {
  it("counts only owner-attested agents and applies the specified resets", () => {
    const declaredOnly = "f".repeat(64);
    const human = "1".repeat(64);
    const events = [
      completion(1),
      { ...completion(2), pubkey: declaredOnly },
      event(3, {
        kind: 9,
        pubkey: human,
        content: "Human decision",
        tags: [
          ["h", channel],
          ["e", rootA, "", "reply"],
        ],
      }),
      completion(4),
      event(5, {
        kind: 40002,
        content: JSON.stringify({ content: "[BLOCKER] Need approval" }),
        tags: [
          ["h", channel],
          ["e", rootA, "", "reply"],
        ],
      }),
      completion(6),
    ];
    const state = foldThreadGovernance(
      { channelId: channel, root: rootA },
      events,
      (pubkey) => (pubkey === agent ? owner : undefined),
      () => false,
    );
    expect(state.count).toBe(1);
    expect(state.resets.map(({ action }) => action)).toEqual([
      "human",
      "blocker-open",
    ]);
  });
});

function harness(relay: EventData[] = []) {
  let sequence = relay.length + 100;
  let pending: OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
  const outbox = {
    supports: (kind: number) => kind === THREAD_GOVERNANCE_KIND,
    snapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(input: Pick<EventData, "kind" | "content" | "tags">) {
      const sent = event(sequence++, { ...input, pubkey: owner });
      relay.push(sent);
      pending = [...pending, { event: sent, delivery: "sending" as const }];
      for (const listener of listeners) listener();
      return sent.id;
    },
  } as Pick<Outbox, "supports" | "snapshot" | "subscribe" | "send"> as Outbox;
  const reader = {
    read: async () => relay as unknown as readonly RelayEvent[],
  } as RelayReader;
  const profiles = {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: async () => {},
    owner: (pubkey: string) => (pubkey === agent ? owner : undefined),
  } as ProfileQueries;
  const capability = createThreadGovernance({
    reader,
    outbox,
    profiles,
    viewer: agent,
    canManage: () => false,
    receive: () => () => {},
  });
  return { capability, relay };
}

it("isolates tripped source threads sharing one session and survives reload", async () => {
  const first = harness();
  const sourceA = { channelId: channel, root: rootA };
  const sourceB = { channelId: channel, root: rootB };
  const controls = new SessionControls(() => {});
  let releaseRunningA!: () => void;
  let markRunningAStarted!: () => void;
  const runningAReleased = new Promise<void>((resolve) => {
    releaseRunningA = resolve;
  });
  const runningAStarted = new Promise<void>((resolve) => {
    markRunningAStarted = resolve;
  });

  // A and B use the same native session control key. This A turn crosses the
  // final handoff seam before the trip and remains active while later work arrives.
  const alreadyRunningA = controls.deliver(
    "shared-native-session",
    async () => {
      const admitted = await first.capability.admit(
        sourceA,
        agent,
        new AbortController().signal,
      );
      markRunningAStarted();
      await runningAReleased;
      admitted.completed();
    },
  );
  await runningAStarted;
  for (let turn = 0; turn < 10; turn++) {
    const admitted = await first.capability.admit(
      sourceA,
      agent,
      new AbortController().signal,
    );
    admitted.completed();
  }

  const pausedA = controls.deliver("shared-native-session", async () => {
    await first.capability.admit(sourceA, agent, new AbortController().signal);
  });
  await expect(pausedA.done).rejects.toThrow(
    "Thread turn budget reached (10/10)",
  );
  const startingB = controls.deliver("shared-native-session", async () => {
    await first.capability.admit(sourceB, agent, new AbortController().signal);
  });
  await expect(startingB.done).resolves.toBeUndefined();

  // It completes normally after the trip: no interrupt, abort, or queue clear.
  releaseRunningA();
  await expect(alreadyRunningA.done).resolves.toBeUndefined();
  first.capability.dispose();

  const restored = harness(first.relay);
  await expect(
    restored.capability.admit(sourceA, agent, new AbortController().signal),
  ).rejects.toThrow("Thread turn budget reached (11/10)");
  await expect(
    restored.capability.admit(sourceB, agent, new AbortController().signal),
  ).resolves.toBeDefined();
  restored.capability.dispose();
});
