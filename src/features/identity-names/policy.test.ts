import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { resolveIdentityNames, type NamingIdentity } from "./policy";

const me = "1".repeat(64),
  wes = "2".repeat(64);
const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64);
const person = (pubkey: string, name = "Honey"): NamingIdentity => ({
  pubkey,
  name,
});
const agent = (
  pubkey: string,
  ownerPubkey?: string,
  name = "Honey",
): NamingIdentity => ({
  pubkey,
  name,
  isAgent: true,
  ...(ownerPubkey ? { ownerPubkey } : {}),
});
const suffix = (key: string) => npubEncode(key).slice(-4);
const owners = [person(me, "Logan"), person(wes, "Wes")];
function labels(rows: NamingIdentity[], viewer = me) {
  const resolved = resolveIdentityNames([...owners, ...rows], viewer);
  expect(resolveIdentityNames([...owners, ...rows].reverse(), viewer)).toEqual(
    resolved,
  );
  return rows.map((row) => resolved.get(row.pubkey)?.name);
}
it("leaves unique names unchanged", () => {
  expect(labels([agent(a, wes)])).toEqual(["Honey"]);
});
it("prefers humans before agents, then mine before others", () => {
  expect(labels([person(c), agent(a, me), agent(b, wes)])).toEqual([
    "Honey",
    "Honey (agent)",
    "Wes’s Honey",
  ]);
  expect(labels([agent(a, me), agent(b, wes)])).toEqual([
    "Honey",
    "Wes’s Honey",
  ]);
  expect(labels([agent(a, me), agent(b, wes)], wes)).toEqual([
    "Logan’s Honey",
    "Honey",
  ]);
});
it("suffixes same-owner duplicates after their readable qualifier", () => {
  expect(labels([agent(a, me), agent(b, me)])).toEqual([
    `Honey · ${suffix(a)}`,
    `Honey · ${suffix(b)}`,
  ]);
  expect(labels([agent(a, wes), agent(b, wes)])).toEqual([
    `Wes’s Honey · ${suffix(a)}`,
    `Wes’s Honey · ${suffix(b)}`,
  ]);
  expect(labels([person(c), agent(a, me), agent(b, me)])).toEqual([
    "Honey",
    `Honey (agent) · ${suffix(a)}`,
    `Honey (agent) · ${suffix(b)}`,
  ]);
});
it("keeps the viewer plain in human collisions and otherwise suffixes both", () => {
  expect(labels([person(me, "Logan"), person(a, "Logan")])).toEqual([
    "Logan",
    `Logan · ${suffix(a)}`,
  ]);
  expect(labels([person(a), person(b)])).toEqual([
    `Honey · ${suffix(a)}`,
    `Honey · ${suffix(b)}`,
  ]);
});
it("rechecks generated possessives and agent markers against literal names", () => {
  expect(
    labels([agent(a, me), agent(b, wes), person(c, "Wes’s Honey")]),
  ).toEqual(["Honey", `Wes’s Honey · ${suffix(b)}`, "Wes’s Honey"]);
  expect(labels([person(c), agent(a, me), person(b, "Honey (agent)")])).toEqual(
    ["Honey", `Honey (agent) · ${suffix(a)}`, "Honey (agent)"],
  );
});
it("tries readable labels before adding any key suffix", () => {
  expect(labels([agent(a), agent(b, wes)])).toEqual(["Honey", "Wes’s Honey"]);
});
it("uses keys when owner names are absent or duplicated, without inventing ownership", () => {
  expect(labels([agent(a), agent(b)])).toEqual([
    `Honey · ${suffix(a)}`,
    `Honey · ${suffix(b)}`,
  ]);
  const other = "3".repeat(64);
  expect(
    labels([agent(a, wes), agent(b, other), person(other, "Wes")]).slice(0, 2),
  ).toEqual([`Wes’s Honey · ${suffix(a)}`, `Wes’s Honey · ${suffix(b)}`]);
});
it("extends only suffixes whose finished labels still collide", () => {
  const first =
    "3ee51d04715939ef0e492f7b87bf1dcaf2c0b4a16b753f19d7a92e96ba01b8db";
  const second =
    "55e2be15c0fb4ba8231701c4ba65d545715b7c79761952fd8a7cc75cf6afb602";
  expect(labels([agent(first, me), agent(second, me), agent(a, me)])).toEqual([
    `Honey · ${npubEncode(first).slice(-7)}`,
    `Honey · ${npubEncode(second).slice(-7)}`,
    `Honey · ${suffix(a)}`,
  ]);
  expect(
    labels([agent(a, me), agent(b, me), person(c, `Honey · ${suffix(a)}`)]),
  ).toEqual([
    `Honey · ${npubEncode(a).slice(-5)}`,
    `Honey · ${suffix(b)}`,
    `Honey · ${suffix(a)}`,
  ]);
  expect(
    resolveIdentityNames([agent(a, me), agent(a.toUpperCase(), me)]).size,
  ).toBe(1);
});

it("does not treat missing viewer and missing owner as a match", () => {
  const rows = [...owners, agent(a), agent(b, wes)];
  const resolved = resolveIdentityNames(rows);
  expect(resolved.get(a)?.name).toBe("Honey");
  expect(resolved.get(b)?.name).toBe("Wes’s Honey");
});

it("normalizes viewer, owner, candidates and repeated keys at the API boundary", () => {
  const viewer = "d".repeat(64);
  const identities = [
    person(viewer, "Logan"),
    agent(a, viewer.toUpperCase()),
    agent(b, wes),
    person(wes, "Wes"),
  ];
  const names = resolveIdentityNames(identities, viewer.toUpperCase(), [
    a.toUpperCase(),
    b.toUpperCase(),
  ]);
  expect(names.get(a)?.name).toBe("Honey");
  expect(names.get(b)?.name).toBe("Wes’s Honey");
  expect(names.size).toBe(2);
  expect(
    resolveIdentityNames(
      [person(viewer, "Alex"), person(a, "Alex")],
      viewer.toUpperCase(),
    ).get(viewer)?.name,
  ).toBe("Alex");
});

it("trims names but keeps differently cased names distinct", () => {
  const distinct = resolveIdentityNames([
    person(a, " Honey "),
    person(b, "honey"),
  ]);
  expect(distinct.get(a)).toEqual({ name: "Honey", qualifier: undefined });
  expect(distinct.get(b)).toEqual({ name: "honey", qualifier: undefined });
  const collision = resolveIdentityNames([
    person(a, " Honey "),
    person(b, "Honey"),
  ]);
  expect(collision.get(a)?.qualifier).toBeTruthy();
  expect(collision.get(b)?.qualifier).toBeTruthy();
});

it("terminates when literal human names exhaust the full key and fallback counters", () => {
  const npub = npubEncode(a);
  const occupied = [
    ...Array.from({ length: npub.length - 3 }, (_, i) => npub.slice(-(i + 4))),
    `${npub} · 1`,
    `${npub} · 2`,
  ].map((qualifier, i) =>
    person((i + 16).toString(16).padStart(64, "0"), `Honey · ${qualifier}`),
  );
  const rows = [agent(a, me), agent(b, me), ...occupied];
  const result = labels(rows);
  expect(result[0]).toBe(`Honey · ${npub} · 3`);
  expect(result[1]).toBe(`Honey · ${suffix(b)}`);
  expect(result.slice(2)).toEqual(occupied.map((row) => row.name));
  expect(new Set(result).size).toBe(rows.length);
});

it("compares all aliases while returning the last requested alias for each key", () => {
  const rows = [
    agent(a, me),
    agent(b, me),
    { ...agent(a, me), name: "Juniper" },
    { ...agent(b, me), name: "Juniper" },
  ];
  for (const ordered of [rows, [...rows].reverse()]) {
    for (const requested of rows) {
      const resolved = resolveIdentityNames([...ordered, requested], me);
      expect(resolved.get(requested.pubkey)?.name).toBe(
        `${requested.name} · ${suffix(requested.pubkey)}`,
      );
    }
  }
  const oneKey = [
    agent(a, me),
    { ...agent(a, me), name: "Juniper" },
    agent(a, me),
  ];
  expect(resolveIdentityNames(oneKey, me).get(a)?.name).toBe("Honey");
});

it("rechecks generated labels against aliases and keeps human priority", () => {
  const literal = `Honey · ${suffix(a)}`;
  const rows = [
    agent(a, me),
    agent(b, me),
    person(c, literal),
    person(c, "Juniper"),
  ];
  const names = resolveIdentityNames(rows, me);
  expect(names.get(a)?.name).toBe(`Honey · ${npubEncode(a).slice(-5)}`);
  expect(names.get(c)?.name).toBe("Juniper");
  expect(
    resolveIdentityNames([...rows, person(c, literal)], me).get(c)?.name,
  ).toBe(literal);
});

const conformance = JSON.parse(
  readFileSync(
    new URL(
      "../../bundled/identity-naming/identity-names.fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  version: number;
  cases: {
    name: string;
    identities: NamingIdentity[];
    viewer?: string;
    candidates?: string[];
    expected: Record<string, { name: string; qualifier: string | null }>;
  }[];
};
it("validates the portable fixture version and non-empty case list", () => {
  expect(conformance.version).toBe(1);
  expect(conformance.cases.length).toBeGreaterThan(0);
});
it.each(conformance.cases)(
  "conforms to the portable naming contract: $name",
  (fixture) => {
    const actual = resolveIdentityNames(
      fixture.identities,
      fixture.viewer,
      fixture.candidates,
    );
    expect(
      Object.fromEntries(
        [...actual].map(([key, value]) => [
          key,
          { name: value.name, qualifier: value.qualifier ?? null },
        ]),
      ),
    ).toEqual(fixture.expected);
  },
);
