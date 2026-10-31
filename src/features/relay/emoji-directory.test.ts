import { afterEach, expect, it, vi } from "vitest";
import {
  createEmojiDirectory,
  EMOJI_PAGE,
  EMOJI_PART_BYTES,
} from "./emoji-directory";
import {
  EMOJI_SET,
  emojiMatches,
  emojiSetD,
  emojiSetPart,
  findCustomEmoji,
  validEmojiSetTemplate,
} from "./emoji";
import type { ReadFilter, RelayEvent } from "./events";
import { keypair, signed, type Key } from "./testing";

const viewer = keypair(),
  member = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const media = (code: string) => `https://a.test/media/${code}.png`;
function part(key: Key, index: number, time: number, codes: string[]) {
  return signed(key, {
    kind: 30030,
    created_at: time,
    content: "",
    tags: [
      ["d", emojiSetD(index)],
      ...codes.map((code) => ["emoji", code, media(code)]),
    ],
  });
}
const dOf = (event: RelayEvent) =>
  event.tags.find(([name]) => name === "d")?.[1];
/** A NIP-01 store of addressable events: newest first, inclusive `until`. */
function fakeRelay(initial: RelayEvent[] = []) {
  const events = new Map<string, RelayEvent>();
  const store = (event: RelayEvent) => {
    const key = `${event.pubkey}/${event.kind}/${dOf(event)}`;
    const old = events.get(key);
    if (!old || event.created_at >= old.created_at) events.set(key, event);
  };
  for (const event of initial) store(event);
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const [filter] = filters;
    if (!filter) return [];
    return [...events.values()]
      .filter(
        (event) =>
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (filter.until === undefined || event.created_at <= filter.until),
      )
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, filter.limit);
  });
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async (event: RelayEvent) => store(event));
  return { events, read, writer: { sign, publish } };
}
function directory(relay: ReturnType<typeof fakeRelay>) {
  const owner = createEmojiDirectory(
    { read: relay.read },
    undefined,
    viewer.pubkey,
    { writer: relay.writer, upload: vi.fn() },
  );
  owners.push(owner);
  return owner;
}

it("names parts with a legacy part 0 and admits only canonical part coordinates", () => {
  expect([0, 1, 42].map(emojiSetD)).toEqual([
    EMOJI_SET,
    `${EMOJI_SET}:1`,
    `${EMOJI_SET}:42`,
  ]);
  for (const [d, index] of [
    [EMOJI_SET, 0],
    [`${EMOJI_SET}:1`, 1],
    [`${EMOJI_SET}:9999`, 9999],
    [`${EMOJI_SET}:0`, undefined],
    [`${EMOJI_SET}:01`, undefined],
    [`${EMOJI_SET}:10000`, undefined],
    [`${EMOJI_SET}:x`, undefined],
    ["other", undefined],
    [undefined, undefined],
  ] as const)
    expect(emojiSetPart(d)).toBe(index);
  const template = (d: string) => ({
    kind: 30030,
    created_at: 1,
    content: "",
    tags: [["d", d]],
  });
  expect(validEmojiSetTemplate(template(`${EMOJI_SET}:3`), 1)).toBe(true);
  expect(validEmojiSetTemplate(template(`${EMOJI_SET}:0`), 1)).toBe(false);
});

it("unions every member's parts across pages and ignores other kind-30030 sets", async () => {
  // 250 parts need three pages; same-second parts repeat across page edges.
  const parts = Array.from({ length: 250 }, (_, index) =>
    part(member, index, 1_000 + Math.floor(index / 3), [`code_${index}`]),
  );
  const relay = fakeRelay([
    ...parts,
    signed(member, {
      kind: 30030,
      created_at: 5_000,
      content: "",
      tags: [
        ["d", "someone-elses-pack"],
        ["emoji", "foreign", media("foreign")],
      ],
    }),
  ]);
  const emoji = directory(relay);
  await emoji.queries.ensure();
  const snapshot = emoji.queries.snapshot();
  expect(snapshot.status).toBe("ready");
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.entries).toHaveLength(250);
  expect(findCustomEmoji(snapshot.entries, "foreign")).toBeUndefined();
  expect(findCustomEmoji(snapshot.entries, "CODE_249")?.url).toBe(
    media("code_249"),
  );
  const filters = relay.read.mock.calls.map(([[filter]]) => filter);
  expect(filters[0]).toEqual({ kinds: [30030], limit: EMOJI_PAGE });
  expect(filters.length).toBeGreaterThanOrEqual(3);
  expect(filters.slice(1).every((filter) => filter?.until !== undefined)).toBe(
    true,
  );
  // A live part replaces only its own coordinate.
  emoji.accept([part(member, 7, 9_000, ["seven"])]);
  expect(findCustomEmoji(emoji.queries.snapshot().entries, "code_7")).toBe(
    undefined,
  );
  expect(emoji.queries.snapshot().entries).toHaveLength(250);
});

it("holds a 100k-emoji community within its budgets and resolves sends by index", async () => {
  const codes = Array.from({ length: 100_000 }, (_, index) => `e${index}`);
  const parts: RelayEvent[] = [];
  for (let index = 0; index * 450 < codes.length; index++)
    parts.push(
      part(
        member,
        index,
        1_000 + index,
        codes.slice(index * 450, (index + 1) * 450),
      ),
    );
  const emoji = directory(fakeRelay(parts));
  await emoji.queries.ensure();
  const snapshot = emoji.queries.snapshot();
  expect(snapshot).toMatchObject({ status: "ready", error: undefined });
  expect(snapshot.entries).toHaveLength(100_000);
  expect(emoji.tags("hi :e99999: :e0: :nope:")).toEqual([
    ["emoji", "e99999", media("e99999")],
    ["emoji", "e0", media("e0")],
  ]);
  expect(
    [...emojiMatches(":E5:", snapshot.entries)].map(({ emoji }) => emoji),
  ).toEqual([{ shortcode: "e5", url: media("e5") }]);
});

it("adds into the first part with room and republishes only that part", async () => {
  // Part 0 is a legacy single set already at the part budget.
  const full = Array.from(
    { length: Math.ceil(EMOJI_PART_BYTES / 40) },
    (_, index) => `legacy_${index}`,
  );
  const relay = fakeRelay([part(viewer, 0, 10, full)]);
  const emoji = directory(relay);
  await emoji.queries.ensure();
  await expect(emoji.queries.add?.("Wave", media("wave"))).resolves.toBe(
    "wave",
  );
  expect(relay.writer.publish).toHaveBeenCalledTimes(1);
  const added = relay.writer.publish.mock.calls[0]?.[0];
  expect(added?.tags).toEqual([
    ["d", `${EMOJI_SET}:1`],
    ["emoji", "wave", media("wave")],
  ]);
  expect(emoji.queries.snapshot().mine.at(-1)).toEqual({
    shortcode: "wave",
    url: media("wave"),
  });
  // Replacing an image keeps the shortcode in its part.
  await emoji.queries.add?.("wave", media("wave2"));
  expect(relay.writer.publish.mock.calls[1]?.[0].tags).toEqual([
    ["d", `${EMOJI_SET}:1`],
    ["emoji", "wave", media("wave2")],
  ]);
  // Removing republishes only the part that held it.
  await emoji.queries.remove?.("legacy_3");
  const removed = relay.writer.publish.mock.calls[2]?.[0];
  expect(dOf(removed as RelayEvent)).toBe(EMOJI_SET);
  expect(removed?.tags).toHaveLength(full.length);
  expect(relay.writer.publish).toHaveBeenCalledTimes(3);
  expect(
    findCustomEmoji(emoji.queries.snapshot().entries, "legacy_3"),
  ).toBeUndefined();
});

it("clears a shortcode a legacy client left in several parts, gaining part first", async () => {
  const relay = fakeRelay([
    part(viewer, 0, 10, ["dup", "keep"]),
    part(viewer, 2, 11, ["dup"]),
  ]);
  const emoji = directory(relay);
  await emoji.queries.add?.("dup", media("new"));
  const published = relay.writer.publish.mock.calls.map(([event]) => event);
  expect(published.map(dOf)).toEqual([EMOJI_SET, `${EMOJI_SET}:2`]);
  expect(published[0]?.tags).toEqual([
    ["d", EMOJI_SET],
    ["emoji", "keep", media("keep")],
    ["emoji", "dup", media("new")],
  ]);
  expect(published[1]?.tags).toEqual([["d", `${EMOJI_SET}:2`]]);
  await emoji.queries.remove?.("dup");
  expect(relay.writer.publish).toHaveBeenCalledTimes(3);
  expect(emoji.queries.snapshot().mine).toEqual([
    { shortcode: "keep", url: media("keep") },
  ]);
});

it("refuses to edit when the viewer's own parts cannot be read completely", async () => {
  const relay = fakeRelay();
  // Every page repeats one second, so the own-part read can never finish.
  relay.read.mockImplementation(async () =>
    Array.from({ length: EMOJI_PAGE }, (_, index) =>
      part(viewer, index, 10, [`same_${index}`]),
    ),
  );
  const emoji = directory(relay);
  await expect(emoji.queries.add?.("wave", media("wave"))).rejects.toThrow(
    "Failed to add emoji.",
  );
  expect(relay.writer.publish).not.toHaveBeenCalled();
});
