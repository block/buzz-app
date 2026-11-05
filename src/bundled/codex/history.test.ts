import { expect, it } from "vitest";
import {
  CONTEXT_BYTES,
  quoted,
} from "../../features/agent-harness/turn-records";
import type { EventData } from "../../features/relay/events";
import { conversationHistory } from "./history";

const message = (index: number, content: string): EventData => ({
  id: index.toString(16).padStart(64, "0"),
  pubkey: "a".repeat(64),
  kind: 9,
  created_at: 1_800_000_000 + index,
  content,
  tags: [["h", "chan"]],
});

it("keeps the newest history messages that fit the check request's budget", async () => {
  const history = async (content: string) => {
    const earlier = Array.from({ length: 50 }, (_, index) =>
      message(index, content),
    );
    const text = await conversationHistory(
      message(50, "now"),
      { channelId: "chan", name: "chan" },
      async (filters) => (filters[0]?.kinds?.includes(9) ? earlier : []),
    );
    const shown = JSON.parse(
      /^<conversation-context>\n(.*)\n/.exec(text)?.[1] ?? "null",
    ).messages as { id: string }[];
    return { earlier, text, shown };
  };
  expect((await history("x".repeat(1000))).shown).toHaveLength(50);
  // Each `<` is escaped in the prompt and again in a check request.
  const { earlier, text, shown } = await history("<".repeat(4000));
  expect(shown.map((item) => item.id)).toEqual(
    earlier.slice(-4).map((item) => item.id),
  );
  const bytes = (value: string) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  const records = quoted(shown);
  expect(text).toContain(records);
  expect(bytes(records)).toBeLessThanOrEqual(CONTEXT_BYTES);
});
