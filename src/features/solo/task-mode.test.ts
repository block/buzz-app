import { afterEach, expect, it, vi } from "vitest";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";
import { keypair, signed } from "../relay/testing";
import {
  recordTaskFirstEvent,
  taskFirstEventRecovery,
  validateTaskPublication,
  TASK_MODE_LABEL,
} from "./task-mode";
import { taskTokenTags } from "../messages/task-tokens";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const viewer = keypair();
  const h = createSoloRegionFixture(viewer.pubkey);
  cleanups.push(h.dispose);
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const eligible = new Set([a, b]);
  const recordFirstEvent = vi.fn(async (input: { preparationId: string }) => {
    if (input.preparationId !== "prepared:7")
      throw new Error("Prepared revision changed");
  });
  const source = await h.register({
    task: {
      prepare: async () => ({ ok: false, reason: "unused" }),
      markChannelStarted: async () => "start",
      recordFirstEvent,
      participants: {
        eligible: (key) => eligible.has(key),
        defaultRecipient: () => a,
        makePrimary: async () => {},
        maxRecipients: 1,
      },
    },
  });
  const channel = {
    id: "task",
    name: "Task",
    channelType: "solo" as const,
    creator: viewer.pubkey,
    members: [viewer.pubkey, a, b],
    labels: ["buzz.solo", source.handle.label, TASK_MODE_LABEL],
  };
  h.roster([channel]);
  const event = (recipients = [a], tags: string[][] = []) =>
    signed(viewer, {
      kind: 9,
      content: "Do work",
      tags: [
        ["h", channel.id],
        ...recipients.map((key) => ["p", key]),
        ...tags,
      ],
    });
  return {
    ...h,
    viewer,
    source,
    eligible,
    recordFirstEvent,
    a,
    b,
    channel,
    event,
  };
}

it("fails closed after disposal or a missing owning region while preserving legacy region chats", async () => {
  const f = await fixture();
  expect(validateTaskPublication(f.session, f.event())?.region).toBe("work");
  await f.source.fiber.dispose();
  expect(() => validateTaskPublication(f.session, f.event())).toThrow(
    "Nexus is unavailable",
  );
  f.roster([{ ...f.channel, labels: ["buzz.solo", TASK_MODE_LABEL] }]);
  expect(() => validateTaskPublication(f.session, f.event())).toThrow(
    "Nexus is unavailable",
  );
  f.roster([{ ...f.channel, labels: ["buzz.solo", f.source.handle.label] }]);
  expect(validateTaskPublication(f.session, f.event())).toBeUndefined();
});

it("checks the whole membership and exact explicit target before local delivery", async () => {
  const f = await fixture();
  f.eligible.delete(f.b);
  expect(() => validateTaskPublication(f.session, f.event([f.a]))).toThrow(
    "participant",
  );
  f.roster([{ ...f.channel, members: [f.viewer.pubkey, f.a] }]);
  expect(() => validateTaskPublication(f.session, f.event([f.b]))).toThrow(
    "selected task agent",
  );
  f.eligible.add(f.b);
  expect(() => validateTaskPublication(f.session, f.event([f.a, f.b]))).toThrow(
    "Tag one agent",
  );
});

it("binds the exact preparation identity and revision before exposing the first event", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const input = {
    draftId: "draft",
    revision: 7,
    preparationId: "prepared:7",
    channelId: "task",
    regionLabel: f.source.handle.label,
  };
  const event = f.event();
  const beforeLocal = await recordTaskFirstEvent(
    f.session,
    event,
    taskFirstEventRecovery(input),
    signal,
  );
  expect(f.recordFirstEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      preparationId: "prepared:7",
      revision: 7,
      eventId: event.id,
      binding: f.source.binding(),
    }),
    expect.any(AbortSignal),
  );
  await expect(
    recordTaskFirstEvent(
      f.session,
      event,
      taskFirstEventRecovery({ ...input, preparationId: "prepared:old" }),
      signal,
    ),
  ).rejects.toThrow("Prepared revision changed");
  await expect(
    recordTaskFirstEvent(
      f.session,
      event,
      taskFirstEventRecovery({ ...input, channelId: "other" }),
      signal,
    ),
  ).rejects.toThrow("does not match");
  f.eligible.delete(f.a);
  expect(() => beforeLocal()).toThrow("participant");
});

it("refuses a skill after a recipient switch and never executes future token versions", async () => {
  const f = await fixture();
  const tokens = taskTokenTags([
    {
      kind: "nexus.skill",
      id: JSON.stringify({ path: "/task/repo/SKILL.md" }),
      label: "/Review",
      target: f.a,
    },
  ]);
  expect(
    validateTaskPublication(f.session, f.event([f.a], tokens)),
  ).toBeDefined();
  expect(() =>
    validateTaskPublication(f.session, f.event([f.b], tokens)),
  ).toThrow("another agent");
  expect(
    validateTaskPublication(
      f.session,
      f.event([f.b], [["nexus.tokens.v2", "future"]]),
    ),
  ).toBeDefined();
});

it("applies task policy to every signed member addition, including a direct outbox retry", async () => {
  const f = await fixture();
  const addition = signed(f.viewer, {
    kind: 9000,
    content: "",
    tags: [
      ["h", f.channel.id],
      ["p", f.b],
    ],
  });
  expect(validateTaskPublication(f.session, addition)?.region).toBe("work");
  f.eligible.delete(f.b);
  expect(() => validateTaskPublication(f.session, addition)).toThrow(
    "participant",
  );
  await f.source.fiber.dispose();
  expect(() => validateTaskPublication(f.session, addition)).toThrow(
    "Nexus is unavailable",
  );
});
