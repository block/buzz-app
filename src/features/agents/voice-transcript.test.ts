import { expect, it, vi } from "vitest";
import type { AgentEventTemplate } from "./native";
import { streamVoiceTranscript } from "./voice-transcript";

it("updates one transcript during speech and gives the final edit a newer relay timestamp", async () => {
  vi.useFakeTimers({ now: 1_000 });
  try {
    const events: (AgentEventTemplate & { created_at: number })[] = [];
    const transcript = streamVoiceTranscript(
      {
        channelId: "conversation",
        root: "a".repeat(64),
        parentId: "b".repeat(64),
      },
      new AbortController().signal,
      () => true,
      async (event) => {
        const created_at = Math.floor(Date.now() / 1_000);
        events.push({ ...event, created_at });
        return { id: String(events.length), created_at };
      },
    );
    transcript.append("One");
    await vi.advanceTimersByTimeAsync(0);
    transcript.append(" two");
    await vi.advanceTimersByTimeAsync(0);
    transcript.append(" three");
    transcript.append(" four");
    await vi.advanceTimersByTimeAsync(1_000);
    const done = transcript.finish("One two three four.");
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(events).toEqual([
      {
        kind: 9,
        tags: [
          ["h", "conversation"],
          ["buzz:message-source", "huddle-transcript"],
          ["e", "a".repeat(64), "", "root"],
          ["e", "b".repeat(64), "", "reply"],
        ],
        content: "One",
        created_at: 1,
      },
      ...["One two", "One two three four", "One two three four."].map(
        (content, index) => ({
          kind: 40003,
          tags: [
            ["h", "conversation"],
            ["e", "1"],
          ],
          content,
          created_at: index + 1,
        }),
      ),
    ]);
  } finally {
    vi.useRealTimers();
  }
});
