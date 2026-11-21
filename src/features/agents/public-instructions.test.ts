import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { verifyPublicInstructions } from "./public-instructions";
import type { EventData } from "../relay/events";

const author = "1".repeat(64),
  community = "https://relay.example.org";
const instructions = "Published instructions";
const event: EventData = {
  id: "2".repeat(64),
  pubkey: author,
  kind: 30175,
  created_at: 1,
  tags: [
    ["d", "helper"],
    ["shared", "true"],
  ],
  content: JSON.stringify({
    display_name: "Helper",
    system_prompt: instructions,
  }),
};
it("derives evidence from the current shared head and exact complete instructions", async () => {
  const read = vi.fn(async () => [event]);
  expect(
    await verifyPublicInstructions(
      { read },
      community,
      `${author}:helper`,
      instructions,
    ),
  ).toEqual({
    community,
    event: event.id,
    sha256: createHash("sha256").update(instructions).digest("hex"),
  });
  expect(read).toHaveBeenCalledWith([
    { kinds: [30175], authors: [author], "#d": ["helper"], limit: 1 },
  ]);
  expect(
    await verifyPublicInstructions(
      { read },
      community,
      `${author}:helper`,
      `${instructions} private addition`,
    ),
  ).toBeUndefined();
});
it("does not read the catalog for private imports or malformed source references", async () => {
  const read = vi.fn(async () => [event]);
  expect(
    await verifyPublicInstructions(
      { read },
      community,
      undefined,
      instructions,
    ),
  ).toBeUndefined();
  expect(
    await verifyPublicInstructions(
      { read },
      community,
      "untrusted",
      instructions,
    ),
  ).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
it.each([
  { ...event, tags: [["d", "helper"]] },
  { ...event, pubkey: "3".repeat(64) },
  { ...event, content: "broken" },
])(
  "omits evidence for unshared, mismatched or malformed catalog heads",
  async (head) => {
    expect(
      await verifyPublicInstructions(
        { read: vi.fn(async () => [head]) },
        community,
        `${author}:helper`,
        instructions,
      ),
    ).toBeUndefined();
  },
);
it("keeps instructions private when catalog verification is unavailable", async () => {
  const read = vi.fn(async () => {
    throw new Error("offline");
  });
  expect(
    await verifyPublicInstructions(
      { read },
      community,
      `${author}:helper`,
      instructions,
    ),
  ).toBeUndefined();
});
