import { describe, expect, it, vi } from "vitest";
import { apply } from "./index";

type Run = (input: unknown) => Promise<void>;

function responder() {
  let run: Run | undefined;
  const ctx = {
    react: { useState: vi.fn() },
    agents2: { register: (type: { run: Run }) => (run = type.run) },
  };
  void apply(ctx as never);
  if (!run) throw new Error("Responder did not register");
  return run;
}

const id = (char: string) => char.repeat(64);

async function replyTo(tags: string[][]) {
  const publish = vi.fn().mockResolvedValue({});
  await responder()({
    trigger: {
      type: "mention",
      event: { id: id("c"), pubkey: id("d"), kind: 9, content: "hi", tags },
    },
    agent: { publish },
    config: { reply: "On it." },
  });
  return publish.mock.calls[0]?.[0]?.tags as string[][] | undefined;
}

describe("responder", () => {
  it("starts a thread under a top-level trigger", async () => {
    expect(await replyTo([["h", "room"]])).toEqual([
      ["h", "room"],
      ["e", id("c"), "", "reply"],
      ["p", id("d")],
    ]);
  });

  it("stays in the thread of a reply that marks only its root as reply", async () => {
    expect(
      await replyTo([
        ["h", "room"],
        ["e", id("a"), "", "reply"],
      ]),
    ).toEqual([
      ["h", "room"],
      ["e", id("a"), "", "root"],
      ["e", id("c"), "", "reply"],
      ["p", id("d")],
    ]);
  });

  it("keeps the root of a nested reply", async () => {
    expect(
      await replyTo([
        ["h", "room"],
        ["e", id("a"), "", "root"],
        ["e", id("b"), "", "reply"],
      ]),
    ).toEqual([
      ["h", "room"],
      ["e", id("a"), "", "root"],
      ["e", id("c"), "", "reply"],
      ["p", id("d")],
    ]);
  });
});
