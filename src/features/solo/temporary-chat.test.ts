import { expect, it } from "vitest";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import {
  TEMPORARY_LABELS,
  findTemporaryChat,
  temporaryAbout,
  temporarySource,
} from "./temporary-chat";
import { SOLO_LABEL } from "./labels";

const viewer = "a".repeat(64);
const source = "11111111-1111-4111-8111-111111111111";
const message = {
  id: "b".repeat(64),
  channelId: source,
  threadRootId: "c".repeat(64),
} as ChannelMessage;

it("names its source in the saved about, and reopens only the viewer's open chat for it", () => {
  const about = temporaryAbout(message, `https://relay.example:${viewer}`);
  expect(temporarySource(about)).toMatchObject({
    channelId: source,
    messageId: message.id,
    rootId: message.threadRootId,
  });
  expect(
    temporarySource("Temporary chat about something else"),
  ).toBeUndefined();
  const chat = (id: string, extra: Partial<ChannelSummary> = {}) =>
    ({
      id,
      name: id,
      members: [viewer],
      channelType: "solo",
      creator: viewer,
      labels: [SOLO_LABEL, ...TEMPORARY_LABELS],
      description: about,
      ...extra,
    }) as ChannelSummary;
  expect(
    findTemporaryChat(
      [
        chat("older", { createdAt: 1 }),
        chat("newer", { createdAt: 2 }),
        chat("archived", { createdAt: 3, archived: true }),
        chat("shared", { createdAt: 4, creator: "d".repeat(64) }),
      ],
      viewer,
      message.id,
    )?.id,
  ).toBe("newer");
});
