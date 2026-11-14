// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import { SOLO_LABEL, SOLO_NAMED_LABEL } from "../solo/labels";
import { ChatNotStarted } from "../relay/channel-writes";
import { signedMessageTokenTags } from "./message-tokens";
import type { ComposerToken } from "./composer-token";
import {
  askInSolo,
  soloAskMessage,
  soloAskName,
  type SoloAsk,
} from "./solo-ask";

const viewer = "a".repeat(64),
  agent = "b".repeat(64),
  twin = "d".repeat(64),
  root = "c".repeat(64);
const foo = "11111111-1111-4111-8111-111111111111",
  bar = "22222222-2222-4222-8222-222222222222";
const scope = `https://one.example:${viewer}`;
afterEach(() => localStorage.clear());

function fakeSession({
  available = true,
  ready = (): Promise<void> => Promise.resolve(),
} = {}) {
  const channels: ChannelSummary[] = [];
  const starts = new Map<string, Promise<void>>();
  const start = vi.fn(
    (
      id: string,
      name: string,
      members: string[],
      _ttl?: number,
      named?: boolean,
      _setup?: unknown,
      options?: { labels?: readonly string[]; about?: string },
    ) => {
      // Confirmed by the relay: private, as every Solo chat starts.
      channels.push({
        id,
        name,
        channelType: "solo",
        visibility: "private",
        creator: viewer,
        members: [viewer, ...members],
        labels: [
          SOLO_LABEL,
          ...(named ? [SOLO_NAMED_LABEL] : []),
          ...(options?.labels ?? []),
        ],
      } as ChannelSummary);
      const started = ready();
      starts.set(id, started);
      return { create: Promise.resolve(), ready: started };
    },
  );
  // The chips a send is signing, as the real publisher reads them.
  const send = vi.fn((..._args: unknown[]) => signedMessageTokenTags());
  const session = {
    viewer,
    scope,
    channels: { list: () => ({ status: "ready", channels }) },
    channelWrites: {
      available,
      start,
      starting: (id: string) => starts.get(id),
    },
    messages: { send },
  } as unknown as Parameters<typeof askInSolo>[0];
  return { session, channels, start, send };
}
const ask = (extra: Partial<SoloAsk> = {}): SoloAsk => ({
  agent: { pubkey: agent, name: "Bestie" },
  question: "Is launch still Thursday?",
  channelId: foo,
  channelName: "buzz-team",
  ...extra,
});

it("names the chat <channel>-ask-<agent>, lowercase and hyphenated", () => {
  expect(soloAskName("buzz-team", "Bestie")).toBe("buzz-team-ask-bestie");
  expect(soloAskName("#Launch  Plans 2026!", "Dr. Pollen ✨")).toBe(
    "launch-plans-2026-ask-dr-pollen",
  );
  expect(soloAskName("Café", "Zoë")).toBe("cafe-ask-zoe");
  expect(soloAskName("🚀", "🤖")).toBe("channel-ask-agent");
  expect(soloAskName("x".repeat(200), "y".repeat(200)).length).toBeLessThan(
    120,
  );
});

it("starts one Solo chat for the first ask from a channel, and continues it for the next", () => {
  const f = fakeSession();
  const first = askInSolo(f.session, ask());
  expect(first.reused).toBe(false);
  expect(f.start).toHaveBeenCalledExactlyOnceWith(
    first.channelId,
    "buzz-team-ask-bestie",
    [agent],
    undefined,
    true,
    undefined,
    {
      labels: [`buzz.ask:${foo}`],
      about: `Questions for Bestie from #buzz-team: buzz://channel/${foo}`,
    },
  );
  expect(f.send).toHaveBeenLastCalledWith(
    first.channelId,
    `Is launch still Thursday?\n\n(Asked from buzz://channel/${foo}, where you can’t reply.)`,
    [agent],
  );
  const second = askInSolo(f.session, ask({ question: "And the venue?" }));
  expect(second).toMatchObject({ channelId: first.channelId, reused: true });
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.lastCall?.[0]).toBe(first.channelId);
});

it("finds the chat by its agent and source channel, not its name", () => {
  const f = fakeSession();
  const first = askInSolo(f.session, ask());
  f.channels.splice(0, 1, {
    ...(f.channels[0] as ChannelSummary),
    name: "renamed",
  });
  // A different device: nothing saved locally.
  localStorage.clear();
  expect(askInSolo(f.session, ask()).channelId).toBe(first.channelId);
});

it("keeps a separate chat for each source channel, and for agents that share a name", () => {
  const f = fakeSession();
  const one = askInSolo(f.session, ask());
  const other = askInSolo(
    f.session,
    ask({ channelId: bar, channelName: "bar" }),
  );
  const named = askInSolo(
    f.session,
    ask({ agent: { pubkey: twin, name: "bestie!" } }),
  );
  expect(new Set([one, other, named].map((item) => item.channelId)).size).toBe(
    3,
  );
  expect(f.start.mock.calls.map((call) => call[1])).toEqual([
    "buzz-team-ask-bestie",
    "bar-ask-bestie",
    "buzz-team-ask-bestie",
  ]);
  expect(askInSolo(f.session, ask()).channelId).toBe(one.channelId);
  expect(
    askInSolo(f.session, ask({ agent: { pubkey: twin, name: "bestie!" } }))
      .channelId,
  ).toBe(named.channelId);
});

it.each([
  [
    "archived",
    (chat: ChannelSummary) => ({ ...chat, archived: true as const }),
  ],
  [
    "without the agent",
    (chat: ChannelSummary) => ({ ...chat, members: [viewer] }),
  ],
  ["someone else's", (chat: ChannelSummary) => ({ ...chat, creator: twin })],
  ["gone", () => undefined],
  // Shared: a Solo chat keeps its labels when it is shared.
  [
    "open to the community",
    (chat: ChannelSummary) => ({ ...chat, visibility: "public" as const }),
  ],
  [
    "joined by someone else",
    (chat: ChannelSummary) => ({
      ...chat,
      members: [...(chat.members ?? []), twin],
    }),
  ],
  [
    "of unconfirmed visibility",
    (chat: ChannelSummary) => ({ ...chat, visibility: undefined }),
  ],
  [
    "private only in saved metadata",
    (chat: ChannelSummary) => ({ ...chat, metadataCached: true as const }),
  ],
])("starts a new chat when the earlier one is %s", (_, change) => {
  const f = fakeSession();
  const first = askInSolo(f.session, ask());
  const changed = change(f.channels[0] as ChannelSummary);
  f.channels.splice(0, 1, ...(changed ? [changed] : []));
  const next = askInSolo(f.session, ask());
  expect(next.reused).toBe(false);
  expect(next.channelId).not.toBe(first.channelId);
  // Later asks continue the replacement.
  expect(askInSolo(f.session, ask()).channelId).toBe(next.channelId);
});

it("remembers a source channel a label can't hold on this device", () => {
  const f = fakeSession();
  const first = askInSolo(f.session, ask({ channelId: "Legacy Room" }));
  expect(f.start.mock.lastCall?.[6]).toEqual({
    about: "Questions for Bestie from #buzz-team: buzz://channel/Legacy%20Room",
  });
  expect(askInSolo(f.session, ask({ channelId: "Legacy Room" }))).toMatchObject(
    {
      channelId: first.channelId,
      reused: true,
    },
  );
});

it("links a thread's root, so the agent reads the thread it was asked from", () => {
  expect(soloAskMessage(ask({ threadRootId: root }), scope)).toBe(
    `Is launch still Thursday?\n\n(Asked from a thread you can’t reply in: buzz://message?channel=${foo}&id=${root}&thread=${root})`,
  );
});

it("creates and sends nothing when Solo chats are unavailable", () => {
  const f = fakeSession({ available: false });
  expect(() => askInSolo(f.session, ask())).toThrow(
    "Solo chats are unavailable right now. Your draft is kept.",
  );
  expect(f.start).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it("continues a chat this device is still starting", () => {
  const f = fakeSession();
  const first = askInSolo(f.session, ask());
  // Listed before the relay confirms it: pending, no visibility yet.
  const { visibility: _visibility, ...listed } = f
    .channels[0] as ChannelSummary;
  f.channels.splice(0, 1, { ...listed, pending: true } as ChannelSummary);
  expect(askInSolo(f.session, ask()).channelId).toBe(first.channelId);
});

it("reports a chat the relay never made, for a reused chat too", async () => {
  const refused = new ChatNotStarted("refused");
  const f = fakeSession({ ready: () => Promise.reject(refused) });
  const first = askInSolo(f.session, ask());
  await expect(first.ready).rejects.toBe(refused);
  // A second ask before the refusal lands continues the starting chat.
  const second = askInSolo(f.session, ask());
  expect(second.reused).toBe(true);
  await expect(second.ready).rejects.toBe(refused);
});

it("signs the question's chips, as an ordinary send does", () => {
  const f = fakeSession();
  const tokens: ComposerToken[] = [
    { kind: "skill", id: "review", label: "review", target: agent },
    { kind: "folder", id: "/work/launch", label: "launch" },
  ];
  askInSolo(f.session, ask({ tokens }));
  const [tag] = (f.send.mock.results[0]?.value ?? []) as string[][];
  expect(tag?.[0]).toBe("buzz-tokens-v1");
  expect(JSON.parse(tag?.[1] ?? "[]")).toEqual(tokens);
  // A question without chips signs none.
  askInSolo(f.session, ask());
  expect(f.send.mock.results[1]?.value).toEqual([]);
});
