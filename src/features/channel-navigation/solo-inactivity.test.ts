import { expect, it } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import { SOLO_INACTIVE_AFTER, inactiveSoloChats } from "./solo-inactivity";

const now = 10_000_000_000;
const hours = (count: number) => (now - count * 3_600_000) / 1000;
const chat = (id: string, extra: Partial<ChannelSummary>): ChannelSummary => ({
  id,
  name: id,
  channelType: "solo",
  ...extra,
});

it("folds chats quiet past 72 hours and reports the next one to cross", () => {
  const result = inactiveSoloChats(
    [
      chat("old", { lastActivityAt: hours(73) }),
      chat("edge", { lastActivityAt: hours(72) }),
      chat("recent", { lastActivityAt: hours(70) }),
      chat("newer", { lastActivityAt: hours(1) }),
    ],
    () => false,
    now,
  );
  expect([...result.ids]).toEqual(["old", "edge"]);
  expect(result.nextAt).toBe(hours(70) * 1000 + SOLO_INACTIVE_AFTER);
});

it("keeps exempt chats and chats with no known message", () => {
  const result = inactiveSoloChats(
    [
      chat("open", { lastActivityAt: hours(100) }),
      chat("unknown", { updatedAt: hours(100) }),
      chat("empty", { activityKnown: true, updatedAt: hours(100) }),
    ],
    (id) => id === "open",
    now,
  );
  expect(result.ids.size).toBe(0);
  expect(result.nextAt).toBe(Infinity);
});
