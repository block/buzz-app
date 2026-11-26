import { expect, it, vi } from "vitest";
import { verifiedSymbol } from "nostr-tools/pure";
import type { RelayEvent } from "../relay/events";
import {
  deliverTableAccess,
  missingTableAccess,
  RESEAL_BATCH,
  type TableAccessDeps,
} from "./access";

const owner = "o".repeat(64);
const event = (id: string, tags: string[][]): RelayEvent => ({
  id,
  pubkey: owner,
  created_at: 1,
  kind: 45010,
  tags,
  content: id,
  sig: "",
  [verifiedSymbol]: true,
});
const head = event("head", [
  ["d", "t1"],
  ["h", "c1"],
  ["type", "buzz.table"],
]);
const grant = (id: string, member: string) =>
  event(id, [
    ["h", "c1"],
    ["type", "buzz.table-key"],
    ["for", member],
    ["table", "t1"],
  ]);

function setup(grants: RelayEvent[], opens: string) {
  const published: RelayEvent[] = [];
  const reseal = vi.fn(
    async (_head: RelayEvent, batch: readonly RelayEvent[], member: string) => {
      if (member === "removed")
        throw new Error("They are not a member of this table's channel");
      if (!batch.some((g) => g.id === opens))
        throw new Error("None of your table keys opens this table");
      return `sealed-for-${member}`;
    },
  );
  const deps: TableAccessDeps = {
    viewer: owner,
    read: async ([filter]) => {
      const all = filter?.["#type"]?.[0] === "buzz.table" ? [head] : grants;
      const matches = (name: string) => (event: RelayEvent) =>
        !filter?.[`#${name}`] ||
        filter[`#${name}`]?.includes(
          event.tags.find((t) => t[0] === name)?.[1] ?? "",
        );
      const offset = filter?.offset ?? 0;
      return all
        .filter(matches("for"))
        .filter(matches("table"))
        .slice(offset, offset + (filter?.limit ?? 0));
    },
    host: { reseal },
    writer: {
      kinds: [45010],
      sign: async (template) => ({
        ...template,
        id: `e${published.length}`,
        pubkey: owner,
        sig: "",
        [verifiedSymbol]: true as const,
      }),
      publish: async (signed) => {
        published.push(signed);
        return signed.id;
      },
    },
  };
  return { deps, published, reseal };
}

it("lists members without a key and delivers one from the owner's grants beyond the first page", async () => {
  const others = Array.from({ length: 600 }, (_, i) =>
    grant(`x${i}`, `member${i}`),
  );
  const mine = Array.from({ length: 530 }, (_, i) => grant(`g${i}`, owner));
  const { deps, published, reseal } = setup(
    [...others, ...mine, grant("a", "agent")],
    "g520",
  );
  const signal = new AbortController().signal;
  expect(
    await missingTableAccess(
      deps,
      "c1",
      [owner, "agent", "member599", "b"],
      signal,
    ),
  ).toEqual(["b"]);

  await deliverTableAccess(deps, "c1", "b", signal);
  expect(reseal).toHaveBeenCalledTimes(Math.floor(520 / RESEAL_BATCH) + 1);
  expect(
    reseal.mock.calls.every(
      ([, batch]) =>
        batch.length <= RESEAL_BATCH &&
        batch.every((g) =>
          g.tags.some((t) => t[0] === "for" && t[1] === owner),
        ),
    ),
  ).toBe(true);
  expect(published).toHaveLength(1);
  expect(published[0]?.content).toBe("sealed-for-b");
  expect(published[0]?.tags).toEqual(
    expect.arrayContaining([
      ["h", "c1"],
      ["type", "buzz.table-key"],
      ["for", "b"],
      ["table", "t1"],
    ]),
  );
});

it("publishes nothing for someone the host finds no longer in the channel", async () => {
  const { deps, published } = setup([grant("g0", owner)], "g0");
  await expect(
    deliverTableAccess(deps, "c1", "removed", new AbortController().signal),
  ).rejects.toThrow(/not a member/);
  expect(published).toEqual([]);
  expect(
    await missingTableAccess(deps, "c1", [owner], new AbortController().signal),
  ).toEqual([]);
});

it("says when the search reached the relay's offset ceiling rather than finding no key", async () => {
  const signal = new AbortController().signal;
  const owners = (count: number) =>
    Array.from({ length: count }, (_, i) => grant(`g${i}`, owner));
  const ceiling = 10_000 + RESEAL_BATCH;

  const full = setup(owners(ceiling), "none");
  await expect(
    deliverTableAccess(full.deps, "c1", "b", signal),
  ).rejects.toThrow(/more key grants than Buzz can search/);
  expect(full.published).toEqual([]);

  const short = setup(owners(ceiling - 1), "none");
  await expect(
    deliverTableAccess(short.deps, "c1", "b", signal),
  ).rejects.toThrow(/None of your table keys opens this table/);

  const last = setup(owners(ceiling), `g${ceiling - 1}`);
  await deliverTableAccess(last.deps, "c1", "b", signal);
  expect(last.published).toHaveLength(1);
});
