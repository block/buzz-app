// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createActivityHistory,
  type HistoryPage,
} from "../../features/agents/activity-history";
import type { RelaySession } from "../../features/relay/session";
import { SavedActivity } from "./SavedActivity";
afterEach(cleanup);
const agent = "a".repeat(64);
const page: HistoryPage = {
  records: [
    {
      id: "one",
      agent,
      kind: "acp_read",
      receivedAt: 0,
      plaintext: JSON.stringify({
        kind: "acp_read",
        channelId: "c",
        turnId: "T",
        seq: 1,
        payload: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Historical output" },
            },
          },
        },
      }),
    },
  ],
  more: false,
  before: null,
  trimmed: false,
  epoch: 1,
  revision: 1,
  channels: ["c"],
};
function fixture() {
  const host = { read: vi.fn(async () => page), delete: vi.fn(async () => {}) };
  const clear = vi.fn();
  const history = createActivityHistory(host, () => true, clear);
  const profiles = new Map();
  const session = {
    activityHistory: history.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    media: () => undefined,
  } as unknown as RelaySession;
  return { host, clear, history, session };
}
it("loads only on disclosure, historical output has no working state, deletion explicitly scopes whole community", async () => {
  const h = fixture();
  render(<SavedActivity session={h.session} agent={agent} channelId="c" />);
  expect(h.host.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Saved Activity" }));
  expect(await screen.findByText("Historical output")).toBeVisible();
  expect(screen.queryByText("Working")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete saved Activity" }),
  );
  expect(screen.getByText(/not just this agent/)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Delete saved Activity for this community",
    }),
  );
  await waitFor(() => expect(h.host.delete).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryByText("Historical output")).toBeNull(),
  );
  expect(h.clear).toHaveBeenCalledOnce();
});
it("bounded incomplete reply history never reaches interval renderer", async () => {
  const h = fixture();
  h.host.read.mockResolvedValue({ ...page, more: true, before: 1 });
  render(
    <SavedActivity
      session={h.session}
      agent={agent}
      channelId="c"
      messageId={"b".repeat(64)}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Saved activity for this response" }),
  );
  expect(
    await screen.findByText(/saved evidence is incomplete or trimmed/),
  ).toBeVisible();
  expect(h.host.read).toHaveBeenCalledTimes(5);
  expect(screen.queryByText("Historical output")).toBeNull();
});
it("delete failure stays visible and retryable, and clear removes decrypted page immediately", async () => {
  const h = fixture();
  h.host.delete.mockRejectedValueOnce(new Error("Archive deletion failed"));
  render(<SavedActivity session={h.session} agent={agent} channelId="c" />);
  fireEvent.click(screen.getByRole("button", { name: "Saved Activity" }));
  await screen.findByText("Historical output");
  fireEvent.click(
    screen.getByRole("button", { name: "Delete saved Activity" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Delete saved Activity for this community",
    }),
  );
  expect(
    (await screen.findAllByText("Archive deletion failed")).length,
  ).toBeGreaterThan(0);
  expect(h.clear).not.toHaveBeenCalled();
  act(() => h.history.clear());
  expect(screen.queryByText("Historical output")).toBeNull();
});

it("keeps delete pending mounted, refuses concurrent delete, and reopens after epoch change", async () => {
  const h = fixture();
  let resolve!: () => void;
  const held = new Promise<void>((r) => {
    resolve = r;
  });
  h.host.delete.mockReturnValueOnce(held);
  render(<SavedActivity session={h.session} agent={agent} channelId="c" />);
  fireEvent.click(screen.getByRole("button", { name: "Saved Activity" }));
  await screen.findByText("Historical output");
  fireEvent.click(
    screen.getByRole("button", { name: "Delete saved Activity" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Delete saved Activity for this community",
    }),
  );
  expect(
    screen.getByRole("button", {
      name: "Delete saved Activity for this community",
    }),
  ).toBeDisabled();
  await expect(h.history.queries.delete()).rejects.toThrow(/unavailable/);
  await act(async () => resolve());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Saved Activity" }));
  await screen.findByText("Historical output");
});

it("rebuilds an exact saved response interval without activating live capture", async () => {
  const h = fixture();
  const messageId = "b".repeat(64);
  const make = (seq: number, kind: string, payload: unknown) => ({
    id: String(seq),
    agent,
    kind,
    receivedAt: seq,
    plaintext: JSON.stringify({
      seq,
      kind,
      channelId: "c",
      turnId: "T",
      sessionId: "S",
      payload,
    }),
  });
  const update = (seq: number, value: unknown) =>
    make(seq, "acp_read", {
      method: "session/update",
      params: { sessionId: "S", update: value },
    });
  const records = [
    make(1, "turn_started", {}),
    update(2, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Only this response work" },
    }),
    update(3, {
      sessionUpdate: "tool_call",
      toolCallId: "send",
      title: "buzz-dev-mcp__shell",
      status: "in_progress",
      rawInput: { command: "buzz messages send" },
    }),
    update(4, {
      sessionUpdate: "tool_call_update",
      toolCallId: "send",
      status: "completed",
      rawOutput: { isError: false },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: JSON.stringify({
              exit_code: 0,
              timed_out: false,
              stdout_truncated: false,
              stdout: JSON.stringify({
                accepted: true,
                event_id: messageId,
                message: "",
                mention_pubkeys: [],
              }),
            }),
          },
        },
      ],
    }),
  ];
  h.host.read.mockResolvedValue({ ...page, records: [...records].reverse() });
  render(
    <SavedActivity
      session={h.session}
      agent={agent}
      channelId="c"
      messageId={messageId}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Saved activity for this response" }),
  );
  expect(await screen.findByText("Only this response work")).toBeVisible();
  expect(screen.queryByText("Working")).toBeNull();
  expect(h.host.read).toHaveBeenCalledTimes(1);
});
