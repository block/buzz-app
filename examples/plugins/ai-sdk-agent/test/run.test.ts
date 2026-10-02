// The whole run against the real AI SDK and Anthropic provider code. Only the wire
// is canned: a streamed Messages API exchange, as the host's fetch would deliver it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentWorkspace } from "@buzz/author";
import { run, type Surroundings } from "../src/run.ts";
import { nodeWorkspace } from "./workspace.ts";

const id = (letter: string) => letter.repeat(64);
const THREAD = [
  ["h", "chan"],
  ["e", id("a"), "", "reply"],
];

/** One content block of a model turn: how it opens, then its deltas. */
type Block = readonly [open: object, ...deltas: object[]];
const text = (...pieces: string[]): Block => [
  { type: "text", text: "" },
  ...pieces.map((piece) => ({ type: "text_delta", text: piece })),
];
const thought = (thinking: string): Block => [
  { type: "thinking", thinking: "" },
  { type: "thinking_delta", thinking },
  { type: "signature_delta", signature: "sig" },
];
const call = (name: string, input: object): Block => [
  {
    type: "tool_use",
    id: `toolu_${name}_${JSON.stringify(input).length}`,
    name,
    input: {},
  },
  { type: "input_json_delta", partial_json: JSON.stringify(input) },
];

/** One Messages API response as server-sent events. */
function turn(stop: "tool_use" | "end_turn", ...blocks: Block[]) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    ...blocks.flatMap(([open, ...deltas], index) => [
      { type: "content_block_start", index, content_block: open },
      ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A row of the live view, as the host would hold it. */
type Row = {
  kind: string;
  label?: string;
  text: string;
  state: "running" | "done" | "error";
  error?: string;
  published?: string;
};

/** The parts of a Messages API request the tests look at. */
type Body = {
  stream: boolean;
  model: string;
  system: unknown;
  messages: unknown;
  tools: { name: string }[];
};

function scene(
  respond: (call: number) => Response,
  options: {
    workspace?: AgentWorkspace;
    signal?: AbortSignal;
    maxSteps?: number;
    secret?: () => Promise<string>;
  } = {},
) {
  const requests: { url: string; key: string | null; body: Body }[] = [];
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const reads: unknown[] = [];
  const secrets: string[] = [];
  const rows: Row[] = [];
  /** The live view as it was each time the agent published. */
  const seen: Row[][] = [];
  const app: Surroundings = {
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    fetch: async (input, init) => {
      const body: Body = JSON.parse(String(init?.body));
      requests.push({
        url: String(input),
        key: new Headers(init?.headers).get("x-api-key"),
        body,
      });
      return respond(requests.length);
    },
    read: async (filters) => {
      reads.push(filters);
      return reads.length === 1
        ? [
            {
              id: id("a"),
              kind: 9,
              pubkey: id("1"),
              created_at: 10,
              content: "We ship Friday.",
              tags: [["h", "chan"]],
            },
          ]
        : [
            {
              id: id("e"),
              kind: 40003,
              pubkey: id("1"),
              created_at: 11,
              content: "We ship Monday.",
              tags: [
                ["h", "chan"],
                ["e", id("a")],
              ],
            },
          ];
    },
    names: async () => new Map([[id("1"), "Ann"]]),
  };
  const delivery = {
    event: {
      id: id("b"),
      kind: 9,
      pubkey: id("1"),
      created_at: 12,
      content: "@Helper when do we ship?",
      tags: [...THREAD, ["p", id("f")]],
      sig: "",
    },
    channelId: "chan",
    agent: {
      id: "agent-1",
      pubkey: id("f"),
      name: "Helper",
      owner: id("1"),
      publish: async (event: {
        kind: number;
        content: string;
        tags?: string[][];
      }) => {
        published.push({
          kind: event.kind,
          content: event.content,
          tags: event.tags ?? [],
        });
        seen.push(structuredClone(rows));
        return {
          id: id(String(published.length)),
          created_at: Math.floor(Date.now() / 1000),
        };
      },
      secret: async (name: string) => {
        secrets.push(name);
        return options.secret ? options.secret() : " sk-test\n";
      },
      ...(options.workspace ? { workspace: options.workspace } : {}),
    },
    // A config saved before the key became a secret; that key is not used.
    config: {
      provider: "anthropic",
      apiKey: "sk-old",
      model: " ",
      instructions: "Be brief.",
    },
    live: {
      step(init: { kind: string; label?: string }) {
        const row: Row = { ...init, text: "", state: "running" };
        rows.push(row);
        return {
          append(piece: string) {
            row.text += piece;
          },
          finish(result?: { error?: string; published?: string }) {
            Object.assign(row, result, {
              state: result?.error ? "error" : "done",
            });
          },
        };
      },
    },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as Parameters<typeof run>[0];
  return { app, delivery, requests, published, reads, secrets, rows, seen };
}

test("a mention is answered in its thread with one message, shown live as it is written", async () => {
  const { app, delivery, requests, published, reads, secrets, rows, seen } =
    scene((call_) =>
      call_ === 1
        ? turn("tool_use", call("read_messages", { scope: "thread" }))
        : turn("end_turn", text("You ", "ship ", "on ", "Monday.")),
    );
  await run(delivery, app);

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://api.anthropic.com/v1/messages");
  // The key is the host's secret, asked for by name, not anything in config.
  assert.deepEqual(secrets, ["API_KEY"]);
  assert.equal(requests[0]?.key, "sk-test");
  assert.equal(requests[0]?.body.stream, true);
  assert.equal(requests[0]?.body.model, "claude-sonnet-4-5");
  assert.match(
    JSON.stringify(requests[0]?.body.system),
    /Be brief\..*You are Helper/s,
  );
  assert.doesNotMatch(JSON.stringify(requests[0]?.body.system), /workspace/);
  assert.match(
    JSON.stringify(requests[0]?.body.messages),
    /Ann \(pubkey 1{64}\) mentioned you.*when do we ship/s,
  );
  // Without a workspace there is nothing to read, edit or run.
  assert.deepEqual(
    requests[0]?.body.tools.map((tool) => tool.name),
    ["read_messages", "post_message"],
  );

  // The tool read the thread as the owner, then the edits of what it found.
  assert.deepEqual(reads, [
    [
      { ids: [id("a")], limit: 1 },
      { kinds: [9], "#h": ["chan"], "#e": [id("a")], limit: 30 },
    ],
    [{ kinds: [40003, 5], "#h": ["chan"], "#e": [id("a")], limit: 500 }],
  ]);
  const result = JSON.stringify(requests[1]?.body.messages);
  assert.match(result, /We ship Monday\./);
  assert.match(result, /Ann/);
  assert.doesNotMatch(result, /Friday/);

  // Exactly one event reaches the relay: the finished message, never an edit.
  assert.deepEqual(published, [
    { kind: 9, content: "You ship on Monday.", tags: THREAD },
  ]);
  // Until then the text was only in the live view, which then hands over to it.
  assert.deepEqual(seen[0], [
    { kind: "read", label: "the thread", text: "", state: "done" },
    { kind: "message", text: "You ship on Monday.", state: "running" },
  ]);
  assert.deepEqual(rows, [
    { kind: "read", label: "the thread", text: "", state: "done" },
    {
      kind: "message",
      text: "You ship on Monday.",
      state: "done",
      published: id("1"),
    },
  ]);
});

test("post_message posts a separate message as the agent, notifying only by pubkey", async () => {
  const { app, delivery, published, rows } = scene((call_) =>
    call_ === 1
      ? turn(
          "tool_use",
          call("post_message", {
            content: "Heads up",
            mention_pubkeys: [id("1")],
          }),
        )
      : turn("end_turn", text("Posted.")),
  );
  await run(delivery, app);
  assert.deepEqual(published, [
    {
      kind: 9,
      content: "Heads up",
      tags: [
        ["h", "chan"],
        ["p", id("1")],
      ],
    },
    { kind: 9, content: "Posted.", tags: THREAD },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.label, row.state]),
    [
      ["tool", "post_message", "done"],
      ["message", undefined, "done"],
    ],
  );
});

test("with a workspace the agent thinks, runs commands and edits files, each a live step", async () => {
  const workspace = nodeWorkspace();
  const { app, delivery, requests, published, rows } = scene(
    (call_) =>
      call_ === 1
        ? turn(
            "tool_use",
            thought("A file first."),
            text("On it."),
            call("bash", { command: "echo one > out.txt\ncat out.txt" }),
          )
        : call_ === 2
          ? turn(
              "tool_use",
              call("bash", { command: "echo broke; exit 3" }),
              call("edit", {
                path: "out.txt",
                edits: [{ oldText: "one", newText: "two" }],
              }),
              call("grep", { pattern: "two" }),
            )
          : turn("end_turn", text("Done.")),
    { workspace },
  );
  await run(delivery, app);

  assert.deepEqual(
    requests[0]?.body.tools.map((tool) => tool.name),
    [
      "read_messages",
      "post_message",
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
    ],
  );
  assert.ok(
    JSON.stringify(requests[0]?.body.system).includes(
      `Your workspace is the directory ${workspace.path}`,
    ),
  );
  // The commands really ran there, and the model was told how each one went.
  assert.equal(
    await readFile(join(workspace.path, "out.txt"), "utf8"),
    "two\n",
  );
  assert.match(JSON.stringify(requests[1]?.body.messages), /"one"/);
  const second = JSON.stringify(requests[2]?.body.messages);
  assert.match(second, /broke\\n\\nCommand exited with code 3/);
  assert.match(second, /Applied 1 edit to out\.txt\./);
  assert.match(second, /out\.txt:1:two/);

  // Each stretch of text is its own message; nothing else is published.
  assert.deepEqual(published, [
    { kind: 9, content: "On it.", tags: THREAD },
    { kind: 9, content: "Done.", tags: THREAD },
  ]);
  assert.deepEqual(rows, [
    { kind: "thinking", text: "A file first.", state: "done" },
    { kind: "message", text: "On it.", state: "done", published: id("1") },
    { kind: "command", label: "echo one > out.txt", text: "", state: "done" },
    {
      kind: "command",
      label: "echo broke; exit 3",
      text: "",
      state: "error",
      error: "Command exited with code 3",
    },
    { kind: "write", label: "out.txt", text: "", state: "done" },
    { kind: "search", label: "two", text: "", state: "done" },
    { kind: "message", text: "Done.", state: "done", published: id("2") },
  ]);
});

test("a run that reaches its step limit says so", async () => {
  const { app, delivery, requests, published } = scene(
    () => turn("tool_use", call("read_messages", { scope: "channel" })),
    { maxSteps: 2 },
  );
  await run(delivery, app);
  assert.equal(requests.length, 2);
  assert.deepEqual(published, [
    {
      kind: 9,
      content: "⚠️ I stopped after 2 rounds of tool calls, before I was done.",
      tags: THREAD,
    },
  ]);
});

test("a run that runs out of time ends its command and says so", async () => {
  const started = Date.now();
  const { app, delivery, published, rows } = scene(
    () =>
      turn(
        "tool_use",
        text("Building."),
        call("bash", { command: "sleep 30" }),
      ),
    { workspace: nodeWorkspace(), signal: AbortSignal.timeout(400) },
  );
  await assert.rejects(run(delivery, app), { name: "TimeoutError" });
  assert.ok(Date.now() - started < 10_000, "the command was left running");
  assert.deepEqual(
    published.map((message) => message.content),
    ["Building.", "⚠️ I ran out of time before I was done."],
  );
  assert.equal(rows.at(-1)?.kind, "command");
});

test("a provider failure is said in the thread and fails the run", async () => {
  const { app, delivery, published } = scene(
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(run(delivery, app), /invalid x-api-key/);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.kind, 9);
  assert.deepEqual(published[0]?.tags, THREAD);
  assert.match(
    published[0]?.content ?? "",
    /couldn't finish: invalid x-api-key/,
  );
  assert.doesNotMatch(published[0]?.content ?? "", /sk-test/);
});

test("a run without a key or a channel never calls the provider", async () => {
  const { app, delivery, requests, published } = scene(
    () => assert.fail("provider called"),
    { secret: () => Promise.reject(new Error("No API key is saved")) },
  );
  await assert.rejects(run(delivery, app), /No API key is saved/);
  assert.deepEqual(
    published.map((message) => message.content),
    ["⚠️ I couldn't finish: No API key is saved"],
  );
  const { channelId: _, ...elsewhere } = delivery;
  await assert.rejects(
    run({ ...elsewhere, event: { ...delivery.event, tags: [] } }, app),
    /no channel/,
  );
  assert.equal(requests.length, 0);
  assert.equal(published.length, 1);
});
