import { expect, test, vi } from "vitest";
import type { AgentWork } from "../../features/agents/providers";
import { ack } from "./index";

const work = (config: Record<string, string>) =>
  ({
    deliveryId: "e:a",
    agent: { id: "a", pubkey: "a", name: "Acky", relayUrl: "wss://r", config },
    owner: "o",
    channelId: "c",
    replyTo: "root",
    threadRootId: "root",
    message: { id: "e", author: "o", content: "@Acky", createdAt: 1, tags: [] },
  }) as AgentWork;

test("replies in the thread as the agent through the bundled buzz CLI", async () => {
  const invoke = vi.fn(async () => ({
    exitCode: 0,
    timedOut: false,
    stdout: "{}",
    stderr: "",
  }));
  await ack(work({ reply: "got it" }), {
    invoke,
    signal: new AbortController().signal,
  });
  expect(invoke).toHaveBeenCalledWith({
    program: "buzz",
    args: [
      "messages",
      "send",
      "--channel",
      "c",
      "--reply-to",
      "root",
      "--content",
      "got it",
    ],
    timeoutSeconds: 30,
  });
});

test("a failed reply is reported, and an empty reply falls back to ack", async () => {
  const invoke = vi.fn(async (_request: unknown) => ({
    exitCode: 3,
    timedOut: false,
    stdout: "",
    stderr: "auth",
  }));
  await expect(
    ack(work({ reply: " " }), { invoke, signal: new AbortController().signal }),
  ).rejects.toThrow("Ackbot reply failed (3): auth");
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    args: expect.arrayContaining(["ack"]),
  });
});
