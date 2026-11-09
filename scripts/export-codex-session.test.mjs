import { expect, it } from "vitest";
import { buildCodex } from "./export-codex-session.mjs";
import { eventBody } from "../src/features/agent-harness/turn-records.ts";

const event = {
  id: "e".repeat(64),
  pubkey: "b".repeat(64),
  kind: 9,
  created_at: 1,
  content: "hi",
  tags: [],
};
const user = (text) => ({
  type: "response_item",
  timestamp: "2026-10-31T12:00:00Z",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  },
});

it("shows a request holding a line or paragraph separator", () => {
  for (const request of ["a\u2028b", "a\u2029b"]) {
    const [row] = buildCodex([
      user(`<buzz-event>\n${eventBody(event, request)}\n</buzz-event>`),
    ]).entries;
    expect(row.preview).toBe(request);
  }
});
