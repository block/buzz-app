import { expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { nameMeChat } from "./me-chat-name";

const first = "a".repeat(64),
  second = "b".repeat(64),
  owner = "c".repeat(64);
const event = {
  content: "Discuss this change",
  tags: [
    ["h", "chat"],
    ["p", first],
    ["p", second],
  ],
} as unknown as RelayEvent;

it("only the first tagged agent names an unchanged new Berd chat, once", async () => {
  let name = event.content;
  const save = vi.fn(async (_base, draft) => {
    name = draft.name;
  });
  const load = vi.fn(async () => ({
    name,
    canEdit: true,
    channelId: "chat",
    version: "v1",
  }));
  const relay = {
    snapshot: () => ({
      status: "ready",
      viewer: owner,
      session: {
        mePlacement: { has: () => true },
        channelDetails: { available: true, load, save },
      },
    }),
  } as unknown as RelayData;
  await nameMeChat(relay, owner, second, event, "Second agent wins?");
  expect(load).not.toHaveBeenCalled();
  await nameMeChat(relay, owner, first, event, "A useful title");
  expect(name).toBe("A useful title");
  await nameMeChat(relay, owner, first, event, "Another title");
  expect(save).toHaveBeenCalledOnce();
  name = "My manual title";
  await nameMeChat(relay, owner, first, event, "Please overwrite");
  expect(name).toBe("My manual title");
  expect(save).toHaveBeenCalledOnce();
});
