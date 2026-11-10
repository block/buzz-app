import { expect, it } from "vitest";
import { geometryFor, type RowGeometry, rowSignature } from "./geometry";
import { createRelaySession } from "../relay/session";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";

const only = <T>(items: readonly T[]) => {
  const [item] = items;
  if (!item) throw new Error("expected one row");
  return item;
};

it("keeps each unchanged row's size across edits, appends, and remounts", () => {
  const first = createRelaySession(null),
    second = createRelaySession(null);
  const a = geometryFor(first.session.channels),
    b = geometryFor(second.session.channels);
  const rows: [RowGeometry, RowGeometry, RowGeometry] = [
    { id: "1", key: "one" },
    { id: "2", key: "two" },
    { id: "3", key: "three" },
  ];
  a.set("a", rows, 900, [[100, -1, 300], 150]);
  // Unmeasured rows and rows whose key changed are left to Virtua's estimate;
  // a new row appended after them is too.
  expect(
    a.get(
      "a",
      [rows[0], rows[1], { id: "3", key: "edited" }, { id: "4", key: "four" }],
      900,
    ),
  ).toEqual([[100, -1, -1, -1], 150]);
  // Older rows loaded before them keep their sizes at the new indices.
  expect(a.get("a", [{ id: "0", key: "zero" }, ...rows], 900)).toEqual([
    [-1, 100, -1, 300],
    150,
  ]);
  expect(a.get("a", rows, 901)).toBeUndefined();
  expect(a.get("a", [{ id: "9", key: "nine" }], 900)).toBeUndefined();
  expect(b.get("a", rows, 900)).toBeUndefined();
  // A row that stayed unmounted keeps its earlier size; a remeasure replaces one.
  a.set("a", rows, 900, [[-1, 200, 310], 160]);
  expect(a.get("a", rows, 900)).toEqual([[100, 200, 310], 160]);
  // Evicted rows are not kept.
  a.set("a", rows.slice(1), 900, [[-1, -1], 160]);
  expect(a.get("a", rows, 900)).toEqual([[-1, 200, 310], 160]);
  for (const id of ["b", "c", "d"]) a.set(id, rows, 900, [[1, 2, 3], 2]);
  expect(a.get("a", rows, 900)).toBeUndefined();
  first.dispose();
  second.dispose();
});

it("changes a row's signature for changed content or profiles", () => {
  const author = keypair();
  const row = only(
    foldMessages("a", "relay", [message(author, "a", "hello", 20)]),
  );
  expect(rowSignature(row, new Map())).not.toBe(
    rowSignature(row, new Map([[author.pubkey, { name: "Author" }]])),
  );
  expect(rowSignature(row, new Map())).not.toBe(
    rowSignature({ ...row, content: "edited" }, new Map()),
  );
});

it("invalidates row geometry when resolved author or mention labels change", () => {
  const author = keypair();
  const row = {
    ...only(foldMessages("a", "relay", [message(author, "a", "hello", 20)])),
    mentions: ["mentioned"],
  };
  const names = new Map([
    [author.pubkey, "Author"],
    ["mentioned", "Mention"],
  ]);
  const resolve = (id: string, fallback: string) => names.get(id) ?? fallback;
  const original = rowSignature(row, new Map(), resolve);
  names.set("mentioned", "Longer mention");
  const renamedMention = rowSignature(row, new Map(), resolve);
  expect(renamedMention).not.toBe(original);
  names.set(author.pubkey, "Longer author");
  expect(rowSignature(row, new Map(), resolve)).not.toBe(renamedMention);
});

it("invalidates cached heights when the workflow owner name arrives or changes", () => {
  const signer = keypair();
  const row = {
    ...only(
      foldMessages("room", "relay", [message(signer, "room", "workflow", 20)]),
    ),
    workflowOwnerId: "owner",
  };
  const before = new Map();
  const after = new Map([["owner", { name: "A much longer workflow owner" }]]);
  expect(rowSignature(row, before)).not.toBe(rowSignature(row, after));
  const resolve = (_id: string, fallback: string) => fallback;
  expect(rowSignature(row, before, resolve)).not.toBe(
    rowSignature(row, after, resolve),
  );
});
