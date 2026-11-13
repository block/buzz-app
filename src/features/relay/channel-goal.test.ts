import { expect, it } from "vitest";
import {
  detailsTemplate,
  validateDetailsTemplate,
} from "./channel-details-protocol";
import { createMessages } from "./messages";
import { foldMessages } from "./fold";
import type { EventData } from "./events";
import type { Outbox } from "./outbox";

const channel = "11111111-1111-4111-8111-111111111111";
const viewer = "a".repeat(64);
const version = "b".repeat(64);

it("writes a channel GOAL through the versioned metadata command", () => {
  const base = {
    name: "work",
    description: "Build it",
    goal: "Old outcome",
    visibility: "private" as const,
  };
  const command = detailsTemplate(channel, { ...base, goal: "Ship V1" }, base);
  expect(command.tags).toContainEqual(["goal", "Ship V1"]);
  expect(() => validateDetailsTemplate(command)).not.toThrow();
});

it("requires and folds a GOAL snapshot on new thread roots", () => {
  let sent: EventData | undefined;
  const outbox = {
    supports: () => true,
    send(input: Pick<EventData, "kind" | "content" | "tags">) {
      sent = {
        ...input,
        id: "c".repeat(64),
        pubkey: viewer,
        created_at: 1,
      };
      return sent.id;
    },
  } as unknown as Outbox;
  const messages = createMessages(
    outbox,
    viewer,
    () => undefined,
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => ({ goal: "Ship V1", version }),
  );
  expect(() => messages.send(channel, "Start work")).toThrow(
    "what decision this thread changes",
  );
  messages.send(
    channel,
    "Start work",
    [],
    [],
    undefined,
    [],
    {},
    {
      goal: "Ship V1",
      version,
      decision: "Choose the release boundary",
    },
  );
  expect(sent?.tags).toEqual(
    expect.arrayContaining([
      ["buzz:goal", "Ship V1"],
      ["buzz:goal-version", version],
      ["buzz:decision", "Choose the release boundary"],
    ]),
  );
  if (!sent) throw new Error("Message was not captured");
  const [row] = foldMessages(channel, "f".repeat(64), [sent]);
  expect(row?.threadGoal).toEqual({
    goal: "Ship V1",
    version,
    decision: "Choose the release boundary",
  });
});
