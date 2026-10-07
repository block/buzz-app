// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "../../features/agents/activity";
import { createRelaySession } from "../../features/relay/session";
import { ActivityDetails } from "./ActivityPanel";

const agent = "a".repeat(64);
const root = "c".repeat(64);
const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
});

function fixture() {
  const observe = vi.fn();
  const owner = createAgentActivity(true, observe, () => true);
  const base = createRelaySession(null);
  const session = { ...base.session, agentActivity: owner.queries };
  disposers.push(
    () => owner.dispose(),
    () => base.dispose(),
  );
  disposers.push(owner.queries.activate());
  owner.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  let serial = 0;
  const send = (events: object[]) =>
    act(() =>
      owner.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({ kind: "batch", payload: { events } }),
        },
        observe.mock.lastCall?.[0] as number,
      ),
    );
  return { session, send };
}
const frame = (turnId: string, kind: string, payload: object = {}) => ({
  kind,
  timestamp: new Date().toISOString(),
  agentIndex: 0,
  channelId: "alpha",
  sessionId: "S",
  turnId,
  payload,
});
const update = (sessionUpdate: string, fields: object) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { update: { sessionUpdate, ...fields } },
});
const prompt = (text: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "session/prompt",
  params: { prompt: [{ type: "text", text }] },
});

it("shows a thread transcript and switches to the whole channel", async () => {
  const { session, send } = fixture();
  send([
    frame("thread", "turn_started", { threadRootEventId: root }),
    frame("thread", "acp_write", prompt("fix the build")),
    frame(
      "thread",
      "acp_read",
      update("agent_thought_chunk", {
        content: { type: "text", text: "Check CI first." },
      }),
    ),
    frame(
      "thread",
      "acp_read",
      update("tool_call", {
        toolCallId: "c1",
        // Adapters name tools themselves; the title is shown as sent.
        title: "pnpm build",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pnpm build" },
      }),
    ),
    frame(
      "thread",
      "acp_read",
      update("agent_message_chunk", {
        content: {
          type: "text",
          text: "Build is green.\n\n- `pnpm build` passed",
        },
      }),
    ),
    frame("main", "turn_started", {}),
    frame(
      "main",
      "acp_write",
      prompt("<context>\nScope: channel\n</context>\nchannel question"),
    ),
    frame("main", "turn_completed"),
  ]);
  render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha", threadRootId: root }}
    />,
  );
  const user = userEvent.setup();
  const panel = screen.getByRole("region", { name: "Agent activity" });
  // The thread scope hides the channel conversation's turn.
  expect(within(panel).getByText("fix the build")).toBeVisible();
  expect(within(panel).queryByText("channel question")).toBeNull();
  expect(within(panel).getByText("Running")).toBeVisible();
  expect(
    within(panel).getByText("pnpm build", { selector: "span" }),
  ).toBeVisible();
  // Replies render as Markdown.
  expect(
    within(panel).getByText("pnpm build", { selector: "li > code" }),
  ).toBeVisible();
  expect(within(panel).getByText("Working…")).toBeVisible();

  expect(within(panel).getByText("Check CI first.")).toBeVisible();
  expect(within(panel).getByText("Build is green.")).toBeVisible();

  // Threads are named by their first prompt; the whole channel shows both
  // conversations, each labeled.
  const scope = within(panel).getByRole("combobox", { name: "Conversation" });
  expect(scope).toHaveTextContent(/^#alpha › .+ · fix the build$/);
  await user.click(scope);
  await user.click(
    await screen.findByRole("option", { name: /^#alpha · whole channel/ }),
  );
  expect(within(panel).getAllByText("channel question")[0]).toBeVisible();
  expect(within(panel).getByText(/Channel conversation/)).toBeVisible();
  expect(
    within(panel).getByText(new RegExp(`Thread ${root.slice(0, 8)}`)),
  ).toBeVisible();

  // Raw keeps the exact diagnostic records.
  await user.click(within(panel).getByRole("tab", { name: "Raw" }));
  expect(
    within(panel).getAllByRole("button", { name: /^acp_write · / })[0],
  ).toBeVisible();
});

it("hides Pi's startup banner and shows session config and edit diffs", async () => {
  const { session, send } = fixture();
  send([
    frame("t", "turn_started", {}),
    frame("t", "session_resolved", { sessionId: "S", isNewSession: true }),
    frame("t", "acp_write", { jsonrpc: "2.0", id: 1, method: "session/new" }),
    frame("t", "acp_read", {
      jsonrpc: "2.0",
      id: 1,
      result: { _meta: { piAcp: { startupInfo: "pi v1 banner" } } },
    }),
    frame(
      "t",
      "acp_read",
      update("agent_message_chunk", {
        content: { type: "text", text: "pi v1 banner" },
      }),
    ),
    frame("t", "session_config_captured", {
      configOptions: [{ category: "model", currentValue: "opus" }],
    }),
    frame("t", "acp_write", prompt("tidy the notes")),
    frame(
      "t",
      "acp_read",
      update("tool_call", {
        toolCallId: "e1",
        title: "edit",
        kind: "edit",
        status: "failed",
        locations: [{ path: "/notes.md" }],
        content: [
          {
            type: "diff",
            path: "/notes.md",
            oldText: "keep\nold line\nend",
            newText: "keep\nnew line\nend",
          },
        ],
      }),
    ),
    frame("t", "turn_completed"),
  ]);
  render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha" }}
    />,
  );
  const user = userEvent.setup();
  const panel = screen.getByRole("region", { name: "Agent activity" });
  expect(within(panel).getByText(/^Turn · .* · opus$/)).toBeVisible();
  expect(within(panel).getByText("· new session")).toBeVisible();
  // Pi's repeated startup banner is not presented as the agent's reply.
  expect(within(panel).queryByText("pi v1 banner")).toBeNull();
  expect(within(panel).getByText("/notes.md")).toBeVisible();
  await user.click(within(panel).getByText("Failed"));
  expect(within(panel).getByText("- old line")).toBeVisible();
  expect(within(panel).getByText("+ new line")).toBeVisible();
  expect(within(panel).queryByText(/keep$/)).toBeNull();
});
