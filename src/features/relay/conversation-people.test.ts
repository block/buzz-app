import { describe, expect, it } from "vitest";
import { conversationMark } from "../../bundled/channels/ConversationIdentity";
import type { ChannelSummary, Profile } from "./contracts";
import { peopleKind } from "./conversation-people";

const me = "a".repeat(64);
const agent = "b".repeat(64);
const person = "c".repeat(64);
const profiles = new Map<string, Profile>([
  [agent, { name: "Agent", isAgent: true } as Profile],
  [person, { name: "Person" } as Profile],
]);
const chat = (patch: Partial<ChannelSummary>): ChannelSummary =>
  ({
    id: "x",
    name: "plan-the-launch",
    channelType: "stream",
    visibility: "private",
    members: [me, agent],
    creator: me,
    ...patch,
  }) as ChannelSummary;

describe("peopleKind", () => {
  it("makes a new untagged chat with only you and an agent a chat with the bubble", () => {
    const channel = chat({});
    expect(peopleKind(channel, me, profiles)).toBe("solo");
    expect(conversationMark(channel, [])).toBe("solo-private");
  });
  it("makes a tagged chat a channel once a person is in it", () => {
    expect(
      peopleKind(
        chat({ channelType: "solo", members: [me, agent, person] }),
        me,
        profiles,
      ),
    ).toBe("stream");
  });
  it("keeps a Public conversation a channel", () => {
    expect(
      peopleKind(
        chat({ visibility: "public", joinRole: "member" }),
        me,
        profiles,
      ),
    ).toBe("stream");
  });
  it("keeps View only with only you and your agents a chat", () => {
    expect(
      peopleKind(
        chat({ visibility: "public", joinRole: "guest" }),
        me,
        profiles,
      ),
    ).toBe("solo");
  });
  it("falls back to the older tag while the roster is unknown", () => {
    expect(
      peopleKind(chat({ channelType: "solo", members: [] }), me, profiles),
    ).toBe("solo");
    expect(peopleKind(chat({ members: [] }), me, profiles)).toBe("stream");
  });
  it("says loading while a member's profile hasn't arrived", () => {
    expect(peopleKind(chat({}), me, new Map())).toBe("loading");
  });
  it("leaves DMs, forums and huddles alone", () => {
    expect(peopleKind(chat({ channelType: "dm" }), me, profiles)).toBe("dm");
    expect(peopleKind(chat({ channelType: "forum" }), me, profiles)).toBe(
      "forum",
    );
    expect(peopleKind(chat({ huddle: true }), me, profiles)).toBe("stream");
  });
});
