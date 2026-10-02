// The whole run against the real AI SDK and Anthropic provider code. Only the wire
// is canned: a streamed Messages API exchange, as a host fetch would deliver it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { run, type Surroundings } from "../src/run.ts";

const id = (letter: string) => letter.repeat(64);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One Messages API response as server-sent events, `gapMs` apart. */
function sse(events: readonly object[], gapMs = 0) {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			async start(controller) {
				for (const event of events) {
					if (gapMs) await pause(gapMs);
					controller.enqueue(
						encoder.encode(
							`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
						),
					);
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}
const turn = (block: object, deltas: readonly object[], stop: string) => [
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
	{ type: "content_block_start", index: 0, content_block: block },
	...deltas.map((delta) => ({ type: "content_block_delta", index: 0, delta })),
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: stop, stop_sequence: null },
		usage: { output_tokens: 5 },
	},
	{ type: "message_stop" },
];

function scene(respond: (call: number, body: any) => Response) {
	const requests: { url: string; key: string | null; body: any }[] = [];
	const published: { kind: number; content: string; tags: string[][] }[] = [];
	const reads: unknown[] = [];
	const app: Surroundings = {
		editIntervalMs: 20,
		fetch: async (input, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push({
				url: String(input),
				key: new Headers(init?.headers).get("x-api-key"),
				body,
			});
			return respond(requests.length, body);
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
			tags: [
				["h", "chan"],
				["e", id("a"), "", "reply"],
				["p", id("f")],
			],
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
				return {
					id: id(String(published.length)),
					created_at: Math.floor(Date.now() / 1000),
				};
			},
		},
		config: {
			provider: "anthropic",
			apiKey: " sk-test\n",
			model: " ",
			instructions: "Be brief.",
		},
		signal: new AbortController().signal,
	} as unknown as Parameters<typeof run>[0];
	return { app, delivery, requests, published, reads };
}

test("a mention is answered in its thread: read with the tool, then a reply that streams in", async () => {
	const { app, delivery, requests, published, reads } = scene((call) =>
		call === 1
			? sse(
					turn(
						{
							type: "tool_use",
							id: "toolu_1",
							name: "read_messages",
							input: {},
						},
						[{ type: "input_json_delta", partial_json: '{"scope":"thread"}' }],
						"tool_use",
					),
				)
			: sse(
					turn(
						{ type: "text", text: "" },
						["You ", "ship ", "on ", "Monday."].map((text) => ({
							type: "text_delta",
							text,
						})),
						"end_turn",
					),
					40,
				),
	);
	await run(delivery, app);

	assert.equal(requests.length, 2);
	assert.equal(requests[0]?.url, "https://api.anthropic.com/v1/messages");
	assert.equal(requests[0]?.key, "sk-test");
	assert.equal(requests[0]?.body.stream, true);
	assert.equal(requests[0]?.body.model, "claude-sonnet-4-5");
	assert.match(
		JSON.stringify(requests[0]?.body.system),
		/Be brief\..*You are Helper/s,
	);
	assert.match(
		JSON.stringify(requests[0]?.body.messages),
		/Ann \(pubkey 1{64}\) mentioned you.*when do we ship/s,
	);
	assert.deepEqual(
		requests[0]?.body.tools.map((tool: { name: string }) => tool.name),
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

	// One message in the mention's thread, then edits of that message, ending complete.
	assert.ok(
		published.length >= 2,
		`expected an edit, got ${published.length} publish`,
	);
	assert.equal(published[0]?.kind, 9);
	assert.deepEqual(published[0]?.tags, [
		["h", "chan"],
		["e", id("a"), "", "reply"],
	]);
	assert.notEqual(published[0]?.content, "You ship on Monday.");
	for (const edit of published.slice(1)) {
		assert.equal(edit.kind, 40003);
		assert.deepEqual(edit.tags, [
			["h", "chan"],
			["e", id("1")],
		]);
	}
	assert.equal(published.at(-1)?.content, "You ship on Monday.");
});

test("post_message posts a separate message as the agent, notifying only by pubkey", async () => {
	const { app, delivery, published } = scene((call) =>
		call === 1
			? sse(
					turn(
						{
							type: "tool_use",
							id: "toolu_1",
							name: "post_message",
							input: {},
						},
						[
							{
								type: "input_json_delta",
								partial_json: JSON.stringify({
									content: "Heads up",
									mention_pubkeys: [id("1")],
								}),
							},
						],
						"tool_use",
					),
				)
			: sse(
					turn(
						{ type: "text", text: "" },
						[{ type: "text_delta", text: "Posted." }],
						"end_turn",
					),
				),
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
		{
			kind: 9,
			content: "Posted.",
			tags: [
				["h", "chan"],
				["e", id("a"), "", "reply"],
			],
		},
	]);
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
	assert.match(
		published[0]?.content ?? "",
		/couldn't finish: invalid x-api-key/,
	);
	assert.doesNotMatch(published[0]?.content ?? "", /sk-test/);
});

test("a run without a key or a channel fails before calling the provider", async () => {
	const { app, delivery, requests, published } = scene(() =>
		assert.fail("provider called"),
	);
	await assert.rejects(run({ ...delivery, config: {} }, app), /API key/);
	const { channelId: _, ...elsewhere } = delivery;
	await assert.rejects(
		run({ ...elsewhere, event: { ...delivery.event, tags: [] } }, app),
		/no channel/,
	);
	assert.equal(requests.length + published.length, 0);
});
