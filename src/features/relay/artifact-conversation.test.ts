import { expect, it } from "vitest";
import {
  artifactConversationId,
  artifactConversationsCapability,
  conversationOpening,
  isConversationOpening,
} from "./artifact-conversation";

const d = "8c1f3d2e-4b5a-4c6d-9e7f-0a1b2c3d4e5f";

it("derives the relay's conversation address from the artifact alone", async () => {
  // The relay's published fixture (NOSTR.md, NIP-AR conversations).
  expect(await artifactConversationId(d)).toBe(
    "3f3e3cd7-3b56-81d9-8dd2-8d8b5b1f6d57",
  );
});

it("is advertised by the relay's supported extensions", () => {
  expect(
    artifactConversationsCapability({
      supported_extensions: ["buzz-artifact-conversations"],
    }),
  ).toBe(true);
  expect(artifactConversationsCapability({ supported_extensions: [] })).toBe(
    false,
  );
});

it("opens exactly one artifact's conversation, and nothing else passes", async () => {
  const opening = await conversationOpening(d, 1);
  expect(opening).toEqual({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", "3f3e3cd7-3b56-81d9-8dd2-8d8b5b1f6d57"],
      ["artifact", d],
    ],
  });
  expect(await isConversationOpening(opening)).toBe(true);
  for (const forged of [
    { ...opening, kind: 9 },
    { ...opening, content: "hello" },
    {
      ...opening,
      tags: [
        ["h", "other"],
        ["artifact", d],
      ],
    },
    { ...opening, tags: [...opening.tags, ["name", "Squatted"]] },
    {
      ...opening,
      tags: [
        ["h", opening.tags[0]?.[1] ?? ""],
        ["artifact", ""],
      ],
    },
  ])
    expect(await isConversationOpening(forged)).toBe(false);
});
