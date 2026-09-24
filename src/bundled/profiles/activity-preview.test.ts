import { expect, it } from "vitest";
import { activityPreview } from "./activity-preview";

const now = Date.parse("2026-09-24T14:00:00Z");
const event = (
  update: unknown,
  channelId: string | null = "alpha",
  turnId = "turn",
) => ({
  kind: "acp_read",
  channelId,
  turnId,
  sessionId: "session",
  timestamp: new Date(now).toISOString(),
  payload: { method: "session/update", params: { update } },
});
const chunk = (text: string, messageId = "message") => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
});
const row = (value: unknown, id = "1", agent = "agent") => ({
  id,
  agent,
  receivedAt: now,
  kind: "acp_read",
  plaintext: JSON.stringify(value),
});
it("joins message chunks and updates tool titles/statuses without duplicating rows", () => {
  const rows = [
    row(event(chunk("Checking "))),
    row(event(chunk("the tests.")), "2"),
    row(
      event({
        sessionUpdate: "tool_call",
        toolCallId: "tool",
        title: "Run tests",
        status: "in_progress",
        rawInput: "secret",
      }),
      "3",
    ),
    row(
      event({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool",
        status: "completed",
        rawOutput: "secret",
      }),
      "4",
    ),
  ];
  expect(
    activityPreview(rows, "agent", "alpha").map(({ label, text }) => ({
      label,
      text,
    })),
  ).toEqual([
    { label: "Assistant", text: "Checking the tests." },
    { label: "Tool completed", text: "Run tests" },
  ]);
});
it("scopes mixed batch children before parsing and excludes foreign identities and unscoped data", () => {
  const batch = row({
    kind: "batch",
    payload: {
      events: [
        event(chunk("visible")),
        event(chunk("foreign"), "beta"),
        event(chunk("unscoped"), null),
      ],
    },
  });
  const rows = [batch, row(event(chunk("other identity")), "2", "other")];
  expect(
    activityPreview(rows, "agent", "alpha").map((item) => item.text),
  ).toEqual(["visible"]);
  expect(activityPreview(rows, "agent", "")).toEqual([]);
});
it("keeps turns separate and bounds the preview to three items of at most 601 characters", () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    row(event(chunk("x".repeat(800)), "alpha", String(i)), String(i)),
  );
  const items = activityPreview(rows, "agent", "alpha");
  expect(items).toHaveLength(3);
  expect(
    items.every(
      (item) => item.text.length === 601 && item.text.startsWith("…"),
    ),
  ).toBe(true);
});
it("ignores prompts, thoughts, malformed updates and unknown payloads", () => {
  const rows = [
    null,
    [],
    {
      kind: "acp_write",
      channelId: "alpha",
      payload: { method: "session/prompt", text: "secret" },
    },
    event({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "secret" },
    }),
    event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", text: "secret" },
    }),
    event({ sessionUpdate: "tool_call" }),
    event({ sessionUpdate: "unknown" }),
  ].map((e, i) => row(e, String(i)));
  expect(activityPreview(rows, "agent", "alpha")).toEqual([]);
});
it("falls back to receipt time for invalid or future timestamps", () => {
  for (const timestamp of ["bad", "9999-01-01", null]) {
    expect(
      activityPreview(
        [row({ ...event(chunk("hello")), timestamp })],
        "agent",
        "alpha",
      )[0]?.timestamp,
    ).toBe(now);
  }
});

it("preserves interleaved message chunks even after three other items update", () => {
  const rows = [row(event(chunk("First ")), "0")];
  for (let i = 1; i <= 4; i++)
    rows.push(row(event(chunk("Other", String(i))), String(i)));
  rows.push(row(event(chunk("last")), "5"));
  expect(activityPreview(rows, "agent", "alpha").at(-1)?.text).toBe(
    "First last",
  );
});
