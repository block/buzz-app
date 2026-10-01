// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ActivityStream } from "./ActivityStream";
import { activityRecords } from "../../features/agents/activity-records";

afterEach(cleanup);
function records() {
  return activityRecords(
    [
      {
        kind: "acp_read",
        payload: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "read",
              title: "buzz-dev-mcp__read_file",
              status: "completed",
              rawInput: { path: "/project/README.md" },
              rawOutput: "<script>unsafe()</script>",
            },
          },
        },
      },
      {
        kind: "acp_read",
        payload: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Checking the result" },
            },
          },
        },
      },
      { kind: "turn_error", payload: { error: "Connection lost" } },
    ].map((value, index) => ({
      id: String(index),
      agent: "agent",
      kind: value.kind,
      receivedAt: index,
      plaintext: JSON.stringify({
        ...value,
        turnId: "turn",
        channelId: "channel",
        sessionId: "session",
      }),
    })),
    "agent",
    "channel",
  );
}
it("puts tools first and keeps progress and diagnostics behind separate disclosures", () => {
  const view = render(<ActivityStream records={records()} />);
  expect(
    screen.getAllByRole("button").map((button) => button.textContent),
  ).toEqual([
    "Read file · README.md",
    "Progress and responses (1)",
    "Diagnostics (1) · Error reported",
  ]);
  expect(screen.queryByText("Checking the result")).not.toBeInTheDocument();
  expect(screen.queryByText("Connection lost")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Read file · README.md" }),
  );
  expect(
    screen.getByText(JSON.stringify("<script>unsafe()</script>")),
  ).toBeInTheDocument();
  expect(view.container.querySelector("script")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Progress and responses (1)" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
  expect(screen.getByText("Checking the result")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Diagnostics (1) · Error reported" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn error" }));
  expect(screen.getByText("Connection lost")).toBeInTheDocument();
});
it("drops details when the underlying capture is cleared", () => {
  const view = render(<ActivityStream records={records()} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Read file · README.md" }),
  );
  view.rerender(<ActivityStream records={[]} />);
  expect(
    screen.queryByText(JSON.stringify("<script>unsafe()</script>")),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Read file/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("No tool activity captured yet."),
  ).toBeInTheDocument();
});

it("shows the most recently updated operation first without losing folded details", () => {
  const source = activityRecords(
    [
      ["first", "First operation"],
      ["second", "Second operation"],
      ["first", "First operation updated"],
    ].map(([toolCallId, title], index) => ({
      id: String(index),
      agent: "agent",
      kind: "acp_read",
      receivedAt: index,
      plaintext: JSON.stringify({
        kind: "acp_read",
        channelId: "channel",
        turnId: "turn",
        sessionId: "session",
        payload: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title,
              status: "completed",
            },
          },
        },
      }),
    })),
    "agent",
    "channel",
  );
  render(<ActivityStream records={source} />);
  expect(
    screen.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["First operation updated", "Second operation"]);
});
