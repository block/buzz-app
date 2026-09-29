// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ActivityStream } from "./ActivityStream";
import { ActivityMessageEntry } from "./ActivityMessageEntry";
import { activityTranscript, type TranscriptEntry } from "./transcript";
import type { RelaySession } from "../../features/relay/session";
import type { ActivityRecord } from "../../features/agents/activity-records";

afterEach(cleanup);
const agent = "a".repeat(64),
  human = "b".repeat(64),
  peer = "c".repeat(64);
const profiles = new Map([
  [agent, { name: "Writer" }],
  [human, { name: "Teammate" }],
  [peer, { name: "Reviewer" }],
]);
const ensure = vi.fn(),
  read = vi.fn(),
  thread = vi.fn();
const session = {
  profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
  read,
  thread,
} as unknown as RelaySession;

it("renders a human request, peer exchange and response from only the selected stream", () => {
  const records: ActivityRecord[] = [];
  const emit = (kind: string, payload: unknown, author = agent) =>
    records.push({
      id: String(records.length),
      envelopeId: String(records.length),
      agent: author,
      receivedAt: records.length,
      kind,
      plaintext: JSON.stringify({
        kind,
        channelId: "alpha",
        turnId: "T",
        payload,
      }),
    });
  const incoming = (author: string, body: string, audience = "everyone") =>
    emit("acp_write", {
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: `<buzz-event type="@mention">\nEvent ID: ${"d".repeat(64)}\nChannel: alpha\nKind: 9\nFrom: Sender (hex: ${author})\nContent: ${body}\nTags: [["h","alpha"],["audience","${audience}"]]\n</buzz-event>`,
          },
        ],
      },
    });
  const update = (value: object) =>
    emit("acp_read", { method: "session/update", params: { update: value } });
  incoming(human, "Please translate the report.");
  update({
    sessionUpdate: "tool_call",
    toolCallId: "send",
    title: "send_message",
    status: "completed",
    rawInput: {
      channel_id: "alpha",
      content: "@Reviewer please check the terminology.",
    },
    rawOutput: { accepted: true, event_id: "e".repeat(64), audience: "agents" },
  });
  incoming(
    peer,
    "@Writer keep león accented. <img src=x onerror=bad>",
    "agents",
  );
  update({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "Duplicate prompt echo" },
  });
  update({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: "Updated the translation with the review feedback.",
    },
  });
  const view = render(
    <ActivityStream
      session={session}
      records={records}
      turns={[]}
      showTurnHeading={false}
      showDiagnostics={false}
    />,
    { reactStrictMode: true },
  );
  expect(screen.queryByRole("article")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "send_message" }));
  fireEvent.click(screen.getByRole("button", { name: "Communication (3)" }));
  // Communications are one-line disclosures; captured bodies stay inert and hidden.
  for (const [article, label, body] of [
    [
      "Reported incoming message from Teammate",
      "Teammate Reported incoming message",
      "Please translate the report.",
    ],
    [
      "Send message from Writer",
      "Writer Send message · Reported sent · Reported coordination",
      "@Reviewer please check the terminology.",
    ],
    [
      "Reported incoming message from Reviewer",
      "Reviewer Reported incoming message · Reported coordination",
      "@Writer keep león accented. <img src=x onerror=bad>",
    ],
  ] as const) {
    const row = within(screen.getByRole("article", { name: article }));
    expect(row.queryByText(body ?? "")).toBeNull();
    expect(row.queryByRole("button", { name: "Message details" })).toBeNull();
    const button = row.getByRole("button", { name: label });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(row.getByText(body ?? "")).toBeTruthy();
  }
  expect(
    screen.getByRole("article", {
      name: "Reported incoming message from Teammate",
    }).textContent,
  ).toContain("Please translate the report.");
  expect(
    screen.getByRole("article", { name: "Send message from Writer" })
      .textContent,
  ).toContain("@Reviewer please check the terminology.");
  const reply = screen.getByRole("article", {
    name: "Reported incoming message from Reviewer",
  });
  expect(reply.textContent).toContain("<img src=x onerror=bad>");
  expect(within(reply).getByText(/Reported coordination/)).toBeTruthy();
  expect(
    within(
      screen.getByRole("article", { name: "Send message from Writer" }),
    ).getByText(/Reported coordination/),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole("article", {
        name: "Reported incoming message from Teammate",
      }),
    ).queryByText(/Reported coordination/),
  ).toBeNull();

  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.queryByText("Duplicate prompt echo")).toBeNull();
  const response = screen.getByRole("article", {
    name: "Response from Writer",
  });
  fireEvent.click(
    within(response).getByRole("button", { name: "Message details" }),
  );
  expect(within(response).getByText(agent)).toBeTruthy();
  fireEvent.click(
    within(reply).getByRole("button", { name: "Message details" }),
  );
  expect(within(reply).getByText(peer)).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  expect(thread).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
  // No separate observer records for Reviewer were used or invented.
  expect(
    activityTranscript(records).groups.every((group) => group.agent === agent),
  ).toBe(true);
});

it("profile requests open full human context, keep agent/unknown exchanges collapsed, and preserve user collapse", () => {
  const body = `${"Human request detail ".repeat(50)}END`;
  const entry: TranscriptEntry = {
    id: "request",
    kind: "prompt",
    title: "request",
    body: "",
    input: "",
    output: "",
    status: "",
    sourceIds: [],
    communication: { direction: "incoming", author: human, body },
  };
  const renderEntry = (author = human, enabled = true) => (
    <ActivityMessageEntry
      entry={{
        ...entry,
        communication: { direction: "incoming", author, body },
      }}
      agent={agent}
      session={session}
      expandHumanRequests={enabled}
      evidence={<p>Technical evidence</p>}
    />
  );
  const view = render(renderEntry(), { reactStrictMode: true });
  expect(screen.getByText(body)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show full text" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Teammate Reported incoming message" }),
  );
  view.rerender(renderEntry());
  expect(screen.queryByText(body)).toBeNull();
  view.unmount();
  for (const author of [agent, "d".repeat(64)]) {
    const candidate = render(renderEntry(author));
    expect(screen.queryByText(body)).toBeNull();
    candidate.unmount();
  }
  const inline = render(renderEntry(human, false));
  expect(screen.queryByText(body)).toBeNull();
  inline.unmount();
});

it.each([
  ["pending", "Pending"],
  ["in_progress", "Running"],
  ["failed", "Failed"],
  ["completed", "Delivery unconfirmed"],
  ["", "Status unknown"],
  ["future", "Status unknown"],
])("preserves %s send state without inventing delivery", (status, label) => {
  const entry: TranscriptEntry = {
    id: "one",
    kind: "tool",
    title: "send_message",
    toolName: "send_message",
    body: "",
    input: "",
    output: "",
    status,
    sourceIds: [],
    communication: { direction: "outgoing", author: agent, body: "Message" },
  };
  render(
    <ActivityMessageEntry
      entry={entry}
      agent={agent}
      session={session}
      evidence={null}
    />,
  );
  expect(screen.getByText(`Send message · ${label}`)).toBeTruthy();
  expect(screen.queryByText(/Delivered/)).toBeNull();
});

it("keeps a message collapsed through updates and supports keyboard body/evidence disclosure", async () => {
  const user = userEvent.setup();
  const body = `${"Captured message ".repeat(60)}END`;
  const communication = { direction: "outgoing" as const, author: agent, body };
  const entry: TranscriptEntry = {
    id: "same-send",
    kind: "tool",
    title: "send_message",
    toolName: "send_message",
    body: "",
    input: "",
    output: "",
    status: "in_progress",
    sourceIds: [],
    communication: { direction: "outgoing", author: agent, body },
  };
  const renderEntry = (value: TranscriptEntry) => (
    <ActivityMessageEntry
      entry={value}
      agent={agent}
      session={session}
      evidence={<p>Evidence contents</p>}
    />
  );
  const view = render(renderEntry(entry), { reactStrictMode: true });
  const trigger = screen.getByRole("button", {
    name: "Writer Send message · Running",
  });
  const finished = {
    ...entry,
    status: "completed",
    communication: { ...communication, eventId: "d".repeat(64) },
  };
  view.rerender(renderEntry(finished));
  expect(
    screen.getByRole("button", { name: "Writer Send message · Reported sent" }),
  ).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Evidence contents")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show full text" })).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(screen.getByText("Evidence contents")).toBeTruthy();
  expect(screen.getByText(body)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show full text" })).toBeNull();
  view.rerender(renderEntry({ ...finished, output: "later diagnostic" }));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  trigger.focus();
  await user.keyboard(" ");
  await waitFor(() => expect(screen.queryByText(body)).toBeNull());
  expect(screen.queryByText("Evidence contents")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.keyboard("{Enter}");
  expect(screen.getByText(body)).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  expect(thread).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
});
