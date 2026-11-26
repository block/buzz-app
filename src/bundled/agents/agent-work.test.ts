import { expect, it } from "vitest";
import type { ReadEvent } from "../../features/drafts-sent/model";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import { agentWorkRows, agentWorkTarget } from "./agent-work";

const viewer = "a".repeat(64);
const agent = "b".repeat(64);
const person = "c".repeat(64);
const hex = (digit: string) => digit.repeat(64);
const channel = (
  id: string,
  channelType: ChannelSummary["channelType"],
  lastActivityAt = 0,
) => ({ id, name: id, channelType, lastActivityAt }) as ChannelSummary;
const item = (
  channelId: string,
  authorId: string,
  createdAt: number,
  rootId?: string,
) =>
  ({
    id: `${channelId}:${rootId ?? ""}:${createdAt}`,
    channelId,
    authorId,
    createdAt,
    ...(rootId ? { rootId } : {}),
  }) as InboxItem;
const root = (id: string, content: string) =>
  ({
    id,
    pubkey: person,
    kind: 9,
    created_at: 1,
    content,
    tags: [],
  }) as ReadEvent;
const rows = (input: Partial<Parameters<typeof agentWorkRows>[0]>) =>
  agentWorkRows({
    channels: [],
    items: [],
    isAgent: (pubkey) => pubkey === agent,
    roots: [],
    ...input,
  });

it("lists Solo chats, and each top level and thread an agent wrote to you in, newest first", () => {
  const result = rows({
    channels: [
      channel("solo", "solo", 50),
      channel("team", "stream"),
      channel("dm", "dm"),
    ],
    items: [
      item("team", agent, 100, hex("1")),
      item("team", agent, 80),
      item("dm", agent, 60, hex("2")),
      item("solo", agent, 70),
      // A person's conversation isn't agent work.
      item("team", person, 200, hex("3")),
    ],
    roots: [root(hex("1"), "**Fix** the build\nmore")],
  });
  expect(result.map(({ id, label }) => ({ id, label }))).toEqual([
    { id: `thread:team:${hex("1")}`, label: "Fix the build more" },
    { id: "chat:team", label: "team" },
    { id: "solo:solo", label: "solo" },
    { id: `thread:dm:${hex("2")}`, label: "Thread" },
  ]);
  expect(result[2]?.at).toBe(70);
});

it("caps the list at 50 and opens a thread beside its channel", () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    channel(`solo-${index}`, "solo", index),
  );
  const result = rows({ channels: many });
  expect(result).toHaveLength(50);
  expect(result[0]?.id).toBe("solo:solo-59");
  const scope = { viewer, communityOrigin: "https://example.test" };
  expect(
    agentWorkTarget({ channelId: "team", rootId: hex("1") }, scope),
  ).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "team",
    messageId: hex("1"),
    threadRootId: hex("1"),
  });
  expect(agentWorkTarget({ channelId: "solo" }, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "solo",
  });
});
