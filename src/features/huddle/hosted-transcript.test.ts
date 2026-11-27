import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { ListenOptions } from "../speech/listen";
import type { Speech } from "../speech/service";
import { startHostedHuddleTranscript } from "./hosted-transcript";

it("commits microphone audio at a pause and updates a single transcript reply", async () => {
  vi.useFakeTimers({ now: 1000 });
  const controller = new AbortController();
  try {
    let options: ListenOptions | undefined;
    const commit = vi.fn();
    const cancel = vi.fn();
    const stop = vi.fn(() => options?.onState?.("idle"));
    const speech = {
      backend: () => "hosted",
      status: () => "ready",
      subscribe: () => () => {},
      listen: vi.fn((next: ListenOptions) => {
        options = next;
        next.onCallLimit?.(5);
        next.onState?.("listening");
        return { stop, cancel, commit };
      }),
    } as unknown as Speech;
    const send = vi.fn((_event: unknown) => "transcript");
    const session = {
      outbox: { send, snapshot: () => [] },
      channelWrites: { delivered: async () => {} },
    } as unknown as RelaySession;
    const root = "a".repeat(64);
    const card = "b".repeat(64);
    const track = {} as MediaStreamTrack;
    const report = vi.fn();
    const hosted = startHostedHuddleTranscript(
      speech,
      () => track,
      session,
      "https://community.example",
      { channelId: "design", root, parentId: card },
      controller.signal,
      () => true,
      () => true,
      report,
    );
    expect(options?.continuous?.track).toBe(track);
    expect(options?.community).toBe("https://community.example");
    for (let i = 0; i < 10; i++) hosted?.input(Array(960).fill(0.05));
    options?.continuous?.onItem("utterance", { delta: "Hello" });
    await vi.advanceTimersByTimeAsync(0);
    options?.continuous?.onItem("utterance", { delta: " there" });
    await vi.advanceTimersByTimeAsync(0);
    expect(commit).not.toHaveBeenCalled();
    for (let i = 0; i < 35; i++) hosted?.input(Array(960).fill(0));
    expect(commit).toHaveBeenCalledOnce();
    options?.continuous?.onItem("utterance", { final: "Hello there." });
    await vi.advanceTimersByTimeAsync(1000);

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      {
        kind: 9,
        content: "Hello",
        tags: [
          ["h", "design"],
          ["buzz:message-source", "huddle-transcript"],
          ["e", root, "", "root"],
          ["e", card, "", "reply"],
        ],
      },
      {
        kind: 40003,
        content: "Hello there",
        tags: [
          ["h", "design"],
          ["e", "transcript"],
        ],
      },
      {
        kind: 40003,
        content: "Hello there.",
        tags: [
          ["h", "design"],
          ["e", "transcript"],
        ],
      },
    ]);
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(speech.listen).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});
