import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { eventDto, type EventData } from "../relay/events";
import { keypair, message, signed } from "../relay/testing";
import { currentMessages } from "./current-messages";

const owner = keypair(),
  agent = keypair(),
  stranger = keypair();
const change = (
  key: ReturnType<typeof keypair>,
  kind: number,
  target: EventData,
  content = "",
) =>
  signed(key, {
    kind,
    content,
    created_at: 30,
    tags: [
      ["h", "c"],
      ["e", target.id],
    ],
  });
const attested = eventDto(
  signed(agent, {
    kind: 0,
    created_at: 10,
    content: "{}",
    tags: [
      [
        "auth",
        owner.pubkey,
        "",
        bytesToHex(
          schnorr.sign(
            createHash("sha256")
              .update(`nostr:agent-auth:${agent.pubkey}:`)
              .digest(),
            owner.secret,
          ),
        ),
      ],
    ],
  }),
);

it("applies the author's edits and deletions and ignores anyone else's", async () => {
  const edited = message(owner, "c", "Use the red palette", 20);
  const deleted = message(owner, "c", "Drop the staging tables", 21);
  const kept = message(owner, "c", "Ship on Friday", 22);
  const read = vi.fn(async () => [
    change(owner, 40003, edited, "Use the blue palette"),
    change(owner, 5, deleted),
    change(stranger, 40003, kept, "Ship today"),
    change(stranger, 9005, kept),
  ]);
  const result = await currentMessages("c", [edited, deleted, kept], read);
  expect(read).toHaveBeenCalledWith([
    {
      kinds: [40003, 5, 9005],
      "#h": ["c"],
      "#e": [edited.id, deleted.id, kept.id],
      limit: 500,
    },
  ]);
  expect(result.map(({ id, content }) => [id, content])).toEqual([
    [edited.id, "Use the blue palette"],
    [kept.id, "Ship on Friday"],
  ]);
});

it("applies an agent's attested owner's edit of its message", async () => {
  const answer = message(agent, "c", "Whole answer", 20);
  const edit = change(owner, 40003, answer, "Spoken");
  const profiles = {
    profiles: vi.fn(async () => {}),
    profile: () => attested,
    authorNames: () => undefined,
  };
  expect(
    (await currentMessages("c", [answer], async () => [edit], profiles))[0]
      ?.content,
  ).toBe("Spoken");
  expect(profiles.profiles).toHaveBeenCalledWith([agent.pubkey]);
  expect(
    (
      await currentMessages("c", [answer], async () => [edit], {
        ...profiles,
        profile: () => undefined,
      })
    )[0]?.content,
  ).toBe("Whole answer");
});

it("reads no profiles when nothing changed", async () => {
  const messages = [message(owner, "c", "Plan", 20)];
  const profiles = {
    profiles: vi.fn(async () => {}),
    profile: () => undefined,
    authorNames: () => undefined,
  };
  expect(await currentMessages("c", messages, async () => [], profiles)).toBe(
    messages,
  );
  expect(profiles.profiles).not.toHaveBeenCalled();
});
