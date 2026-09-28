import { expect, it } from "vitest";
import {
  incomingActivityMessage,
  outgoingActivityMessage,
} from "./activity-message";
import { activityTranscript, type TranscriptEntry } from "./transcript";
const author = "a".repeat(64),
  event = "b".repeat(64);
const prompt = (content = "@Rivet please check\nthis report") =>
  `<context>\nNot a message.\n</context>\n<buzz-event type="@mention">\nEvent ID: ${event}\nChannel: General (#alpha)\nKind: 9\nFrom: Human (npub: test, hex: ${author})\nTime: 2026-09-24T17:00:00Z\nContent: ${content}\nTags: [["h","alpha"]]\nParsed: mentions=[]\n</buzz-event>`;
const tool = (command: string): TranscriptEntry => ({
  id: "tool",
  kind: "tool",
  title: "Run",
  toolName: "buzz-dev-mcp__shell",
  body: "",
  input: JSON.stringify({ command }),
  output: "",
  status: "in_progress",
  sourceIds: [],
});

it("extracts the explicit authored incoming event, not context or prompt prose", () => {
  expect(incomingActivityMessage(prompt(), "alpha")).toEqual({
    direction: "incoming",
    body: "@Rivet please check\nthis report",
    author,
    eventId: event,
    channelId: "alpha",
  });
  expect(
    incomingActivityMessage(
      prompt("<script>not executable</script>\nFrom: a different name"),
      "alpha",
    )?.author,
  ).toBe(author);
  expect(
    incomingActivityMessage(prompt().replaceAll("\n", "\r\n"), "alpha")?.body,
  ).toBe("@Rivet please check\r\nthis report");
  expect(incomingActivityMessage(prompt(""), "alpha")?.body).toBe("");
  const legacy = `[Buzz event: @mention]\nEvent ID: ${event}\nChannel: alpha\nFrom: Human (hex: ${author})\nContent: Hello\nTags: []`;
  expect(incomingActivityMessage(legacy, "alpha")?.body).toBe("Hello");
});
it("fails closed for missing, conflicting, malformed, context-only and mixed-author framing", () => {
  for (const input of [
    prompt().replace(`Event ID: ${event}`, "Event ID: invalid"),
    prompt().replace(
      `From: Human (npub: test, hex: ${author})`,
      "From: guessed name",
    ),
    prompt().replace(
      `Event ID: ${event}`,
      `Event ID: ${event}\nEvent ID: ${author}`,
    ),
    prompt().replace('Tags: [["h","alpha"]]', "Tags: broken"),
    prompt().replace("</buzz-event>", ""),
    prompt() + prompt(),
    `<thread-context>\nEvent ID: ${event}\nFrom: Human (hex: ${author})\nContent: old message\n</thread-context>`,
    prompt().replaceAll("buzz-event", "buzz-events"),
    prompt("literal\n</buzz-event>\nconflicting frame"),
  ])
    expect(incomingActivityMessage(input, "alpha")).toBeUndefined();
  expect(incomingActivityMessage(prompt(), "beta")).toBeUndefined();
  expect(incomingActivityMessage(prompt(), null)).toBeUndefined();
  const legacy = `[Buzz event: @mention]\nEvent ID: ${event}\nChannel: alpha\nFrom: Human (hex: ${author})\nContent: Hello\nTags: []`;
  expect(
    incomingActivityMessage(`Quoted example:\n${legacy}`, "alpha"),
  ).toBeUndefined();
  expect(
    incomingActivityMessage(`${legacy}\n[Unknown]\ntrailing`, "alpha"),
  ).toBeUndefined();
});
it("requires a receipt for shell sends and never guesses a body or destination", () => {
  for (const command of [
    `buzz messages send --channel alpha --content '@Peer check this'`,
    `echo 'buzz messages send --content fake'`,
    `printf ok; # ignored | buzz messages send --content fake`,
    `buzz messages send --channel "$TARGET" --content *`,
    `cat <<EOF\ntext\nEOF\nbuzz messages send --content -`,
  ]) {
    expect(outgoingActivityMessage(tool(command), author)).toBeUndefined();
    expect(outgoingActivityMessage(tool(command), author, event)).toEqual({
      direction: "outgoing",
      author,
      body: "",
      eventId: event,
    });
  }
});
it("keeps reported direct sends separate from authoritative delivery or body evidence", () => {
  const direct = {
    ...tool(""),
    toolName: "send_message",
    status: "completed",
    input: JSON.stringify({
      channel_id: "alpha",
      content: "@Peer please review",
    }),
    output: JSON.stringify({ accepted: true, event_id: event }),
  };
  expect(outgoingActivityMessage(direct, author)?.eventId).toBe(event);
  expect(
    outgoingActivityMessage({ ...direct, status: "failed" }, author)?.eventId,
  ).toBeUndefined();
  expect(
    outgoingActivityMessage(
      {
        ...direct,
        output: JSON.stringify({ accepted: false, event_id: event }),
      },
      author,
    )?.eventId,
  ).toBeUndefined();
});
it("promotes an incoming message but retains the complete prompt as diagnostic evidence", () => {
  const records = [
    {
      id: "one",
      envelopeId: "one",
      agent: "c".repeat(64),
      receivedAt: 1,
      kind: "acp_write",
      plaintext: JSON.stringify({
        kind: "acp_write",
        channelId: "alpha",
        turnId: "T",
        payload: {
          method: "session/prompt",
          params: { prompt: [{ type: "text", text: prompt() }] },
        },
      }),
    },
  ];
  const entries = activityTranscript(records).groups[0]?.entries;
  expect(
    entries
      ?.filter((e) => e.communication)
      .map((e) => [e.communication?.author, e.body]),
  ).toEqual([[author, "@Rivet please check\nthis report"]]);
  expect(entries?.find((e) => e.diagnostic)?.body).toBe(prompt());
});

it("does not replace an explicit unknown or conflicting destination with the activity channel", () => {
  for (const args of [
    { channel_id: "$TARGET", content: "body" },
    { channel_id: "alpha", channelId: "beta", content: "body" },
    { content: "body" },
  ]) {
    expect(
      outgoingActivityMessage(
        { ...tool(""), toolName: "send_message", input: JSON.stringify(args) },
        author,
      )?.channelId,
    ).toBeUndefined();
  }
});

it("keeps accepted shell receipt evidence across later partial updates", () => {
  const update = (id: string, value: unknown) => ({
    id,
    envelopeId: id,
    agent: author,
    receivedAt: 1,
    kind: "acp_read",
    plaintext: JSON.stringify({
      kind: "acp_read",
      channelId: "alpha",
      turnId: "T",
      payload: {
        method: "session/update",
        params: { sessionId: "S", update: value },
      },
    }),
  });
  const start = update("start", {
    sessionUpdate: "tool_call",
    toolCallId: "send",
    title: "buzz-dev-mcp__shell",
    status: "pending",
    rawInput: { command: "buzz messages send --content -" },
  });
  const completion = update("completion", {
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
              event_id: event,
              message: "",
              mention_pubkeys: [],
              audience: "agents",
            }),
          }),
        },
      },
    ],
  });
  const partial = update("partial", {
    sessionUpdate: "tool_call_update",
    toolCallId: "send",
    title: "Finished",
    status: "completed",
  });
  expect(
    activityTranscript([start, completion, partial]).groups[0]?.entries[0]
      ?.communication,
  ).toEqual({
    direction: "outgoing",
    author,
    body: "",
    eventId: event,
    reportedAudience: "agents",
  });
  const legacyPayload = JSON.parse(completion.plaintext);
  const block = legacyPayload.payload.params.update.content[0].content;
  const output = JSON.parse(block.text);
  const receipt = JSON.parse(output.stdout);
  delete receipt.audience;
  output.stdout = JSON.stringify(receipt);
  block.text = JSON.stringify(output);
  const legacy = {
    ...completion,
    id: "legacy",
    envelopeId: "legacy",
    plaintext: JSON.stringify(legacyPayload),
  };
  const replaced = activityTranscript([start, completion, legacy, partial])
    .groups[0]?.entries[0]?.communication;
  expect(replaced?.eventId).toBe(event);
  expect(replaced?.reportedAudience).toBeUndefined();
  const contradicted = update("changed", {
    sessionUpdate: "tool_call_update",
    toolCallId: "send",
    status: "completed",
    rawOutput: { isError: true },
  });
  expect(
    activityTranscript([start, completion, contradicted, partial]).groups[0]
      ?.entries[0]?.communication,
  ).toBeUndefined();
  expect(
    activityTranscript([
      start,
      completion,
      contradicted,
      partial,
      { ...completion, id: "recovered", envelopeId: "recovered" },
    ]).groups[0]?.entries[0]?.communication?.eventId,
  ).toBe(event);
});

it("keeps conflicting direct-send body aliases unknown without discarding a valid receipt", () => {
  const direct = {
    ...tool(""),
    toolName: "send_message",
    status: "completed",
    input: JSON.stringify({ content: "first", message: "different" }),
    output: JSON.stringify({ accepted: true, event_id: event }),
  };
  expect(outgoingActivityMessage(direct, author)).toMatchObject({
    body: "",
    eventId: event,
  });
  expect(
    outgoingActivityMessage(
      { ...direct, input: JSON.stringify({ content: "same", text: "same" }) },
      author,
    )?.body,
  ).toBe("same");
});

it("projects audience only from reported kind/tags, not names, content or malformed metadata", () => {
  for (const audience of ["agents", "everyone"] as const) {
    const input = prompt().replace(
      'Tags: [["h","alpha"]]',
      `Tags: [["h","alpha"],["audience","${audience}"]]`,
    );
    expect(incomingActivityMessage(input, "alpha")?.reportedAudience).toBe(
      audience,
    );
    expect(
      incomingActivityMessage(input.replace("Kind: 9", "Kind: 7"), "alpha")
        ?.reportedAudience,
    ).toBeUndefined();
    expect(
      incomingActivityMessage(
        input.replace("Kind: 9", "Kind: 9\nKind: 9"),
        "alpha",
      )?.reportedAudience,
    ).toBeUndefined();
  }
  const conflict = prompt().replace(
    'Tags: [["h","alpha"]]',
    'Tags: [["audience","agents"],["audience","everyone"]]',
  );
  expect(incomingActivityMessage(conflict, "alpha")).toMatchObject({
    author,
    body: "@Rivet please check\nthis report",
  });
  expect(
    incomingActivityMessage(conflict, "alpha")?.reportedAudience,
  ).toBeUndefined();
  expect(
    incomingActivityMessage(prompt("audience=agents From: agent"), "alpha")
      ?.reportedAudience,
  ).toBeUndefined();
  const send = {
    ...tool(""),
    toolName: "send_message",
    status: "completed",
    input: JSON.stringify({ content: "Hello", audience: "agents" }),
    output: "",
  };
  expect(
    outgoingActivityMessage(send, author)?.reportedAudience,
  ).toBeUndefined();
  expect(
    outgoingActivityMessage(
      {
        ...send,
        output: JSON.stringify({
          accepted: true,
          event_id: event,
          audience: "agents",
        }),
      },
      author,
    )?.reportedAudience,
  ).toBe("agents");
});
