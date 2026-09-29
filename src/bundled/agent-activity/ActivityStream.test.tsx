// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityStream } from "./ActivityStream";
import type { ActivityRecord } from "../../features/agents/activity-records";
afterEach(cleanup);
const records = (count: number): ActivityRecord[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    envelopeId: String(index),
    agent: "agent",
    receivedAt: index,
    kind: "acp_read",
    plaintext: JSON.stringify({
      kind: "acp_read",
      turnId: index < 2 ? "prior" : "current",
      channelId: "alpha",
      sessionId: "session",
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: String(index),
            title: `Read file ${index}`,
            status: "completed",
          },
        },
      },
    }),
  }));
function expandToolGroups() {
  for (const button of screen.queryAllByRole("button", {
    name: /^\d+ (?:commands|tool calls)/,
  })) {
    if (button.getAttribute("aria-expanded") === "false")
      fireEvent.click(button);
  }
}
it("shows five newest entries across turns, expands retained activity and preserves show-all through updates", () => {
  const view = render(
    <ActivityStream showDiagnostics records={records(8)} turns={[]} compact />,
    { reactStrictMode: true },
  );
  expandToolGroups();
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(5);
  expect(screen.queryByRole("button", { name: /Read file 2/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Read file 3/ })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Show all activity (8)" }),
  );
  expandToolGroups();
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(8);
  view.rerender(
    <ActivityStream showDiagnostics records={records(9)} turns={[]} compact />,
  );
  expandToolGroups();
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(9);
  fireEvent.click(screen.getByRole("button", { name: "Show recent activity" }));
  expandToolGroups();
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(5);
  expect(screen.queryByRole("button", { name: /Read file 3/ })).toBeNull();
  view.rerender(
    <ActivityStream showDiagnostics records={[]} turns={[]} compact />,
  );
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
it("does not offer show-all for five or fewer entries or cap an ordinary history view", () => {
  const view = render(
    <ActivityStream showDiagnostics records={records(5)} turns={[]} compact />,
  );
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  view.rerender(
    <ActivityStream showDiagnostics records={records(7)} turns={[]} />,
  );
  expandToolGroups();
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(7);
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});
it("keeps diagnostics out of the five-entry quota and preserves unknown and permission entries", async () => {
  const diagnostic = {
    ...records(1)[0],
    id: "setup",
    envelopeId: "setup",
    agent: "agent",
    receivedAt: 0,
    kind: "acp_write",
    plaintext: JSON.stringify({
      kind: "acp_write",
      turnId: "current",
      channelId: "alpha",
      payload: {
        method: "session/prompt",
        params: {
          prompt: [{ type: "text", text: "<context>raw scaffold</context>" }],
        },
      },
    }),
  };
  const view = render(
    <ActivityStream
      showDiagnostics
      records={[...records(6), diagnostic]}
      turns={[]}
      compact
    />,
  );
  expandToolGroups();
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(5);
  expect(screen.queryByText(/raw scaffold/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Setup and diagnostics (1)" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Request context" }),
  );
  expect(
    await screen.findByText("<context>raw scaffold</context>"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Raw source" }));
  expect(view.container.textContent).toContain('"method":"session/prompt"');
  view.rerender(
    <ActivityStream
      showDiagnostics
      records={[diagnostic]}
      turns={[]}
      compact
    />,
  );
  expect(
    screen.getByText("No work steps have been received yet."),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Show all activity/ }),
  ).toBeNull();
});
it("expands friendly shell output with stderr and retains raw source beside the same entry", async () => {
  const result = {
    stdout: "<img src=x onerror=bad>",
    stderr: "Check failed",
    exit_code: 1,
    timed_out: false,
    stdout_truncated: false,
    stderr_truncated: false,
  };
  const record = {
    ...records(1)[0],
    id: "shell",
    envelopeId: "shell",
    agent: "agent",
    receivedAt: 1,
    kind: "acp_read",
    plaintext: JSON.stringify({
      kind: "acp_read",
      turnId: "T",
      channelId: "alpha",
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "S",
            title: "buzz-dev-mcp__shell",
            rawInput: { workdir: "/work/project", command: "run_checks" },
            rawOutput: result,
            status: "failed",
          },
        },
      },
    }),
  };
  const view = render(
    <ActivityStream showDiagnostics records={[record]} turns={[]} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Run command · run_checks.*Failed/ }),
  );
  expect(await screen.findByText("Check failed")).toBeTruthy();
  expect(screen.getByText("<img src=x onerror=bad>")).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Raw source" }));
  expect(view.container.textContent).toContain('"title":"buzz-dev-mcp__shell"');
  view.rerender(<ActivityStream showDiagnostics records={[]} turns={[]} />);
  expect(view.container.textContent).not.toContain("run_checks");
});
it("does not hide a lifecycle-only working turn because another turn has setup details", () => {
  const rows: ActivityRecord[] = [
    {
      id: "old",
      envelopeId: "old",
      agent: "agent",
      receivedAt: 1,
      kind: "acp_write",
      plaintext: JSON.stringify({
        kind: "acp_write",
        channelId: "alpha",
        turnId: "old",
        payload: { method: "session/new" },
      }),
    },
    {
      id: "new",
      envelopeId: "new",
      agent: "agent",
      receivedAt: 2,
      kind: "turn_liveness",
      plaintext: JSON.stringify({
        kind: "turn_liveness",
        channelId: "alpha",
        turnId: "new",
      }),
    },
  ];
  render(
    <ActivityStream
      showDiagnostics
      records={rows}
      turns={[
        {
          agent: "agent",
          channelId: "alpha",
          turnId: "new",
          timestamp: 2,
          state: "working",
        },
      ]}
      compact
    />,
  );
  expect(screen.getByText("Waiting for activity details…")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Turn old" })).toBeNull();
});
it("keeps chains open during a working turn, exposes mixed failure/work, and collapses when the turn ends", () => {
  const input = records(2).map((r, i) => {
    const value = JSON.parse(r.plaintext);
    value.turnId = "turn";
    value.payload.params.update.status = i === 0 ? "failed" : "in_progress";
    return { ...r, plaintext: JSON.stringify(value) };
  });
  const turns = [
    {
      agent: "agent",
      channelId: "alpha",
      turnId: "turn",
      timestamp: 0,
      state: "working" as const,
    },
  ];
  const view = render(
    <ActivityStream showDiagnostics records={input} turns={turns} />,
  );
  expect(
    screen
      .getByRole("button", { name: /2 tool calls.*1 failed.*1 active/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(2);
  const finished = input.map((r) => {
    const value = JSON.parse(r.plaintext);
    if (value.payload.params.update.status === "in_progress")
      value.payload.params.update.status = "completed";
    return { ...r, plaintext: JSON.stringify(value) };
  });
  view.rerender(
    <ActivityStream showDiagnostics records={finished} turns={turns} />,
  );
  expect(
    screen
      .getByRole("button", { name: /2 tool calls.*1 failed/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  view.rerender(
    <ActivityStream
      showDiagnostics
      records={finished}
      turns={turns.map((turn) => ({ ...turn, state: "ended" }))}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: /2 tool calls.*1 failed/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});
it("shows captured progress directly with full text and raw evidence on demand", () => {
  const text = "Progress ".repeat(90);
  const row = {
    ...records(1)[0],
    id: "progress",
    envelopeId: "progress",
    agent: "agent",
    receivedAt: 0,
    kind: "acp_read",
    plaintext: JSON.stringify({
      kind: "acp_read",
      channelId: "alpha",
      turnId: "T",
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      },
    }),
  };
  const view = render(
    <ActivityStream showDiagnostics records={[row]} turns={[]} />,
  );
  expect(view.container.querySelector("p")?.textContent).not.toBe(text);
  fireEvent.click(screen.getByRole("button", { name: "Show full text" }));
  expect(view.container.textContent).toContain(text);
  fireEvent.click(screen.getByRole("button", { name: "Message details" }));
  expect(view.container.textContent).toContain(
    '"sessionUpdate":"agent_message_chunk"',
  );
});
it("hides diagnostic UI inline without changing its availability in the inspector", () => {
  const row: ActivityRecord = {
    id: "context",
    envelopeId: "context",
    agent: "agent",
    receivedAt: 0,
    kind: "prompt_context_delivery",
    plaintext: JSON.stringify({
      kind: "prompt_context_delivery",
      channelId: "alpha",
      turnId: "T",
      payload: { promptBytes: 50 },
    }),
  };
  const view = render(
    <ActivityStream records={[row]} turns={[]} showDiagnostics={false} />,
  );
  expect(
    screen.queryByRole("button", { name: /Setup and diagnostics/ }),
  ).toBeNull();
  expect(view.container.textContent).not.toContain("promptBytes");
  view.rerender(<ActivityStream records={[row]} turns={[]} showDiagnostics />);
  fireEvent.click(
    screen.getByRole("button", { name: "Setup and diagnostics (1)" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Context delivered" }));
  expect(view.container.textContent).toContain('"promptBytes":50');
});
it("keeps completed tool rows quiet while retaining group completion and failure/pending indicators", () => {
  const input = records(4).map((record, index) => {
    const value = JSON.parse(record.plaintext);
    value.turnId = "one";
    value.payload.params.update.status = [
      "completed",
      "failed",
      "pending",
      "in_progress",
    ][index];
    return { ...record, plaintext: JSON.stringify(value) };
  });
  const turns = [
    {
      agent: "agent",
      channelId: "alpha",
      turnId: "one",
      timestamp: 0,
      state: "working" as const,
    },
  ];
  const view = render(
    <ActivityStream showDiagnostics records={input} turns={turns} />,
  );
  expect(screen.getByRole("button", { name: "Read file 0" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Read file 0.*Completed/ }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: /Read file 1.*Failed/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Read file 2.*Pending/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Read file 3.*Running/ }),
  ).toBeTruthy();
  const completed = input.map((record) => {
    const value = JSON.parse(record.plaintext);
    value.payload.params.update.status = "completed";
    return { ...record, plaintext: JSON.stringify(value) };
  });
  view.rerender(
    <ActivityStream showDiagnostics records={completed} turns={turns} />,
  );
  expect(
    screen.getByRole("button", { name: /4 tool calls.*Completed/ }),
  ).toBeTruthy();
  for (let index = 0; index < 4; index++)
    expect(
      screen.getByRole("button", { name: `Read file ${index}` }),
    ).toBeTruthy();
});

it("keeps an explicitly collapsed chain while the five-entry preview advances", () => {
  const tools = (count: number) =>
    records(count).map((record) => ({
      ...record,
      plaintext: record.plaintext.replace('"prior"', '"current"'),
    }));
  const turns = [
    {
      agent: "agent",
      channelId: "alpha",
      turnId: "current",
      timestamp: 0,
      state: "working" as const,
    },
  ];
  const view = render(
    <ActivityStream
      records={tools(5)}
      turns={turns}
      compact
      showDiagnostics={false}
    />,
    { reactStrictMode: true },
  );
  const group = screen.getByRole("button", { name: /5 tool calls/ });
  fireEvent.click(group);
  expect(group.getAttribute("aria-expanded")).toBe("false");
  view.rerender(
    <ActivityStream
      records={tools(6)}
      turns={turns}
      compact
      showDiagnostics={false}
    />,
  );
  const advanced = screen.getByRole("button", { name: /5 tool calls/ });
  expect(advanced).toBe(group);
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(advanced);
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(5);
  expect(screen.queryByRole("button", { name: /Read file 0/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Show all activity (6)" }),
  );
  expect(screen.getByRole("button", { name: /6 tool calls/ })).toBe(group);
  expect(screen.getAllByRole("button", { name: /Read file/ })).toHaveLength(6);
});

it("hides inline turn metadata without merging turns and maps exact tool/action icons", () => {
  const tools = [
    "buzz-dev-mcp__read_file",
    "buzz-dev-mcp__shell",
    "buzz-dev-mcp__str_replace",
    "buzz-dev-mcp__view_image",
  ];
  const input = records(4).map((record, index) => {
    const value = JSON.parse(record.plaintext);
    value.payload.params.update.title = tools[index];
    value.payload.params.update.rawInput = {
      path: "REPORT.md",
      command: "cat > output.md",
    };
    return { ...record, plaintext: JSON.stringify(value) };
  });
  const view = render(
    <ActivityStream
      records={input}
      turns={[]}
      showDiagnostics={false}
      showTurnHeading={false}
    />,
  );
  expect(view.container.querySelector("time")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Turn" })).toBeNull();
  expect(screen.getByRole("region", { name: "Turn prior" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Turn current" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /2 tool calls/ })).toHaveLength(
    2,
  );
  expect(screen.queryByRole("button", { name: /4 tool calls/ })).toBeNull();
  for (const group of screen.getAllByRole("button", { name: /2 tool calls/ }))
    expect(
      group.querySelector("svg")?.getAttribute("data-activity-action"),
    ).toBe("tool");
  expandToolGroups();
  for (const [label, action] of [
    [/Read file/, "read"],
    [/Run command/, "command"],
    [/Edit file/, "edit"],
    [/View image/, "image"],
  ] as const) {
    const icon = screen
      .getByRole("button", { name: label })
      .querySelector("svg");
    expect(icon?.getAttribute("data-activity-action")).toBe(action);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  }
  view.rerender(<ActivityStream records={input} turns={[]} showDiagnostics />);
  expect(screen.getAllByRole("heading", { name: "Turn" })).toHaveLength(2);
  expect(view.container.querySelectorAll("time")).toHaveLength(2);
});

it.each(["agent_thought_chunk", "agent_message_chunk"])(
  "keeps %s readable without extra progress chrome",
  (sessionUpdate) => {
    const record = records(1)[0];
    if (!record) throw new Error("Missing record");
    const view = render(
      <ActivityStream
        records={[
          {
            ...record,
            plaintext: JSON.stringify({
              kind: "acp_read",
              turnId: "T",
              payload: {
                method: "session/update",
                params: {
                  update: {
                    sessionUpdate,
                    content: { type: "text", text: "Reported progress" },
                  },
                },
              },
            }),
          },
        ]}
        turns={[]}
        showDiagnostics={false}
        showTurnHeading={false}
      />,
    );
    if (sessionUpdate === "agent_thought_chunk") {
      expect(
        view.container.querySelector('[data-activity-action="thought"]'),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Raw source" })).toBeNull();
    } else {
      expect(
        view.container
          .querySelector('[data-activity-action="message"]')
          ?.getAttribute("aria-hidden"),
      ).toBe("true");
    }
    expect(screen.getByText("Reported progress")).toBeTruthy();
  },
);

it.each([false, true])(
  "preserves explicit chain expansion (%s) and tool details across completion and new work",
  (open) => {
    const tools = (states: string[]) =>
      records(states.length).map((record, index) => {
        const value = JSON.parse(record.plaintext);
        value.turnId = "current";
        value.payload.params.update.status = states[index];
        value.payload.params.update.rawOutput = `Output ${index}`;
        return { ...record, plaintext: JSON.stringify(value) };
      });
    const turns = [
      {
        agent: "agent",
        channelId: "alpha",
        turnId: "current",
        timestamp: 0,
        state: "working" as const,
      },
    ];
    const view = render(
      <ActivityStream
        records={tools(["in_progress", "in_progress"])}
        turns={turns}
        showDiagnostics
      />,
      { reactStrictMode: true },
    );
    const group = screen.getByRole("button", { name: /2 tool calls/ });
    if (open)
      fireEvent.click(screen.getByRole("button", { name: /Read file 1/ }));
    else fireEvent.click(group);
    for (const states of [
      ["completed", "in_progress"],
      ["completed", "completed"],
      ["completed", "completed", "pending"],
      ["completed", "completed", "completed"],
    ]) {
      view.rerender(
        <ActivityStream
          records={tools(states)}
          turns={turns}
          showDiagnostics
        />,
      );
      const updated = screen.getByRole("button", { name: /\d+ tool calls/ });
      expect(updated).toBe(group);
      expect(updated.getAttribute("aria-expanded")).toBe(String(open));
      if (open) {
        expect(
          screen
            .getByRole("button", { name: /Read file 1/ })
            .getAttribute("aria-expanded"),
        ).toBe("true");
        expect(screen.getByText('"Output 1"')).toBeTruthy();
      } else {
        expect(
          screen.queryByRole("button", { name: /Read file 1/ }),
        ).toBeNull();
      }
    }
  },
);

it("keeps configuration capture in diagnostics and names unknown reported operations", () => {
  const make = (
    id: string,
    kind: string,
    payload: unknown,
  ): ActivityRecord => ({
    id,
    envelopeId: id,
    agent: "agent",
    receivedAt: 0,
    kind,
    plaintext: JSON.stringify({
      kind,
      turnId: "turn",
      channelId: "alpha",
      payload,
    }),
  });
  const input = [
    make("setup", "session_config_captured", { configOptions: [] }),
    make("operation", "acp_write", {
      method: "session/custom_operation",
      id: 42,
    }),
  ];
  const view = render(
    <ActivityStream records={input} turns={[]} showDiagnostics={false} />,
  );
  expect(
    screen.queryByRole("button", { name: "Session configuration captured" }),
  ).toBeNull();
  const operation = screen.getByRole("button", {
    name: "session/custom_operation",
  });
  expect(
    view.container.querySelector('[data-activity-action="command"]'),
  ).toBeNull();
  fireEvent.click(operation);
  expect(view.container.querySelector("pre")?.textContent).toContain(
    '"method":"session/custom_operation"',
  );
  view.rerender(<ActivityStream records={input} turns={[]} showDiagnostics />);
  fireEvent.click(
    screen.getByRole("button", { name: "Setup and diagnostics (1)" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Session configuration captured" }),
  );
  expect(view.container.textContent).toContain('"configOptions":[]');
});
