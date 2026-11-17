import { expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools";
import { assertRailLayoutIntent, mutateRailLayout } from "./rail-layout.mjs";

const payload = {
  version: 1,
  order: ["custom:a"],
  sections: [{ id: "custom:a", title: "Mine" }],
  placements: [],
  pins: [],
  teamExpanded: false,
};

it("reads, replaces and refuses a stale write of the account's arrangement", async () => {
  const key = generateSecretKey();
  let head;
  const run = (intent) =>
    mutateRailLayout(
      intent,
      key,
      async () => (head ? [head] : []),
      async (event) => {
        head = event;
      },
    );
  expect(await run({})).toEqual({ payload: undefined, createdAt: 0 });
  const { createdAt } = await run({ payload, base: 0 });
  expect(head.tags).toEqual([
    ["d", "rail-layout"],
    ["t", "rail-layout"],
  ]);
  expect(head.content).not.toContain("Mine");
  expect(await run({})).toEqual({ payload, createdAt });
  expect(await run({ payload, base: 0 })).toEqual({ conflict: true });
  expect((await run({ payload, base: createdAt })).createdAt).toBe(
    createdAt + 1,
  );
});

it("signs only the bounded arrangement", () => {
  for (const intent of [
    { payload },
    { payload, base: -1 },
    { payload: { ...payload, extra: 1 }, base: 0 },
    { payload: { ...payload, sections: [{ id: "a" }] }, base: 0 },
    { payload: { ...payload, order: Array(201).fill("a") }, base: 0 },
    { base: 0 },
  ])
    expect(() => assertRailLayoutIntent(intent)).toThrow();
});
