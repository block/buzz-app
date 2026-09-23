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
