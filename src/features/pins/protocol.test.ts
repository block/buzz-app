import { describe, expect, test } from "vitest";
import type { EventData } from "../relay/events";
import {
  canPin,
  canUnpin,
  foldPins,
  parsePin,
  pinWrite,
  unpinWrite,
} from "./protocol";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const message = (n: number) => n.toString(16).padStart(64, "0");

function event(
  partial: Partial<EventData> & Pick<EventData, "id" | "kind">,
): EventData {
  return {
    pubkey: ALICE,
    created_at: 100,
    content: "",
    tags: [],
    ...partial,
  };
}
const pin = (id: string, target: string, extra: Partial<EventData> = {}) =>
  event({
    id,
    kind: 40004,
    tags: [
      ["h", CHANNEL],
      ["e", target],
      ["client-id", id],
    ],
    ...extra,
  });

describe("pins protocol", () => {
  test("a pin names one channel and one message", () => {
    expect(parsePin(pin("p1", message(1)))).toEqual({
      id: "p1",
      channelId: CHANNEL,
      messageId: message(1),
      pinnedBy: ALICE,
      pinnedAt: 100,
    });
    for (const tags of [
      [["e", message(1)]],
      [
        ["h", CHANNEL],
        ["e", message(1)],
        ["e", message(2)],
      ],
      [
        ["h", CHANNEL],
        ["e", "not-hex"],
      ],
    ])
      expect(parsePin(event({ id: "x", kind: 40004, tags }))).toBeUndefined();
    expect(
      parsePin({ ...pin("p1", message(1)), content: "hello" }),
    ).toBeUndefined();
    expect(parsePin({ ...pin("p1", message(1)), kind: 9 })).toBeUndefined();
  });

  test("folding keeps one pin per message, newest first, in this channel", () => {
    const pins = foldPins(
      [
        pin("p1", message(1), { created_at: 100 }),
        pin("p2", message(2), { created_at: 300 }),
        pin("p1", message(1), { created_at: 100 }),
        pin("p3", message(1), { created_at: 200, pubkey: BOB }),
        pin("p4", message(3), {
          tags: [
            ["h", OTHER],
            ["e", message(3)],
          ],
        }),
        event({ id: "m", kind: 9, tags: [["h", CHANNEL]] }),
      ],
      CHANNEL,
    );
    expect(pins.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  test("the pinner's kind 5 or any relay-stored kind 9005 removes a pin", () => {
    const own = event({
      id: "d1",
      kind: 5,
      tags: [
        ["h", CHANNEL],
        ["e", "p1"],
        ["k", "40004"],
      ],
    });
    const stranger = { ...own, id: "d2", pubkey: BOB };
    const moderator = {
      ...own,
      id: "d3",
      kind: 9005,
      pubkey: BOB,
      tags: [
        ["h", CHANNEL],
        ["e", "p2"],
        ["k", "40004"],
      ],
    };
    const pins = [pin("p1", message(1)), pin("p2", message(2))];
    expect(foldPins([...pins, stranger], CHANNEL)).toHaveLength(2);
    expect(foldPins([...pins, own], CHANNEL).map((p) => p.id)).toEqual(["p2"]);
    expect(foldPins([moderator, ...pins], CHANNEL).map((p) => p.id)).toEqual([
      "p1",
    ]);
  });

  test("a removed pin lets the message be pinned again", () => {
    const removal = event({
      id: "d1",
      kind: 5,
      tags: [["e", "p1"]],
    });
    const pins = foldPins(
      [
        pin("p1", message(1)),
        removal,
        pin("p2", message(1), { created_at: 200 }),
      ],
      CHANNEL,
    );
    expect(pins.map((p) => p.id)).toEqual(["p2"]);
  });

  test("writes match the relay's pin and unpin shapes", () => {
    expect(pinWrite(CHANNEL, message(1))).toEqual({
      kind: 40004,
      content: "",
      tags: [
        ["h", CHANNEL],
        ["e", message(1)],
      ],
    });
    const mine = parsePin(pin("p1", message(1)));
    if (!mine) throw new Error("pin");
    expect(unpinWrite(mine, ALICE)).toEqual({
      kind: 5,
      content: "",
      tags: [
        ["h", CHANNEL],
        ["e", "p1"],
        ["k", "40004"],
      ],
    });
    expect(unpinWrite(mine, BOB).kind).toBe(9005);
  });

  test("members pin; the pinner, owners and admins unpin", () => {
    expect(canPin("member")).toBe(true);
    expect(canPin("bot")).toBe(true);
    expect(canPin("guest")).toBe(false);
    expect(canPin(undefined)).toBe(false);
    const mine = parsePin(pin("p1", message(1)));
    if (!mine) throw new Error("pin");
    expect(canUnpin(mine, ALICE, "member")).toBe(true);
    expect(canUnpin(mine, BOB, "member")).toBe(false);
    expect(canUnpin(mine, BOB, "admin")).toBe(true);
    expect(canUnpin(mine, BOB, "owner")).toBe(true);
    expect(canUnpin(mine, undefined, undefined)).toBe(false);
  });
});
