import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig, validate } from "../src/config.ts";
import { hostFetch } from "../src/host-fetch.ts";
import { createReply } from "../src/reply.ts";
import { editTags, fold, messageTags, threadRoot } from "../src/thread.ts";

const id = (letter: string) => letter.repeat(64);

test("saved config of any shape becomes a usable config or a named problem", () => {
	assert.equal(validate(undefined), "Enter an Anthropic API key.");
	assert.equal(
		validate({ provider: "openai", apiKey: " " }),
		"Enter an OpenAI API key.",
	);
	assert.equal(validate({ apiKey: "k" }), undefined);
	assert.deepEqual(parseConfig({ provider: "nope", apiKey: " k ", model: 4 }), {
		provider: "anthropic",
		apiKey: " k ",
		model: "",
		instructions: parseConfig({}).instructions,
	});
});

test("a reply lands in the thread of the message it answers", () => {
	const top = { id: id("a"), tags: [["h", "c"]] };
	const reply = {
		id: id("b"),
		tags: [
			["h", "c"],
			["e", id("a"), "", "reply"],
		],
	};
	const nested = {
		id: id("c"),
		tags: [
			["h", "c"],
			["e", id("a"), "", "root"],
			["e", id("b"), "", "reply"],
		],
	};
	assert.equal(threadRoot(top), id("a"));
	assert.equal(threadRoot(reply), id("a"));
	assert.equal(threadRoot(nested), id("a"));
	assert.deepEqual(messageTags("c", id("a"), [id("d"), id("d")]), [
		["h", "c"],
		["e", id("a"), "", "reply"],
		["p", id("d")],
	]);
	assert.deepEqual(messageTags("c"), [["h", "c"]]);
	assert.throws(() => messageTags("c", "not-an-id"));
	assert.throws(() => messageTags("c", undefined, ["@alice"]));
	assert.deepEqual(editTags("c", id("a")), [
		["h", "c"],
		["e", id("a")],
	]);
});

test("a read shows each message as its author last left it", () => {
	const event = (
		name: string,
		kind: number,
		pubkey: string,
		created_at: number,
		content: string,
		target?: string,
	) => ({
		id: id(name),
		kind,
		pubkey,
		created_at,
		content,
		tags: [["h", "c"], ...(target ? [["e", id(target), "", "reply"]] : [])],
	});
	const shown = fold([
		event("b", 9, "bot", 20, "Hel", "a"),
		event("a", 9, "ann", 10, "question"),
		event("1", 40003, "bot", 22, "Hello there", "b"),
		event("2", 40003, "bot", 21, "Hello", "b"),
		event("3", 40003, "eve", 30, "forged", "b"),
		event("d", 9, "ann", 30, "oops"),
		event("4", 5, "ann", 31, "", "d"),
		event("5", 5, "eve", 32, "", "a"),
	]);
	assert.deepEqual(shown, [
		{ id: id("a"), pubkey: "ann", created_at: 10, content: "question" },
		{
			id: id("b"),
			pubkey: "bot",
			created_at: 20,
			content: "Hello there",
			thread: id("a"),
		},
	]);
});

test("a streamed reply is one message, then edits no closer than a second apart", async () => {
	let clock = 10_000;
	const published: {
		kind: number;
		content: string;
		tags: string[][];
		at: number;
	}[] = [];
	const reply = createReply({
		channelId: "c",
		rootId: id("a"),
		intervalMs: 1500,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		publish: async (event) => {
			published.push({ ...event, at: clock });
			return {
				id: id(String(published.length)),
				created_at: Math.floor(clock / 1000),
			};
		},
	});
	reply.append("Hel");
	assert.equal(
		published.length,
		0,
		"nothing is posted before the first interval",
	);
	clock += 1500;
	reply.append("lo");
	reply.append(" wor");
	await Promise.resolve();
	clock += 100;
	// The final text follows the first post by 100 ms: it must wait out the second.
	reply.append("ld ");
	await reply.finish();
	assert.deepEqual(
		published.map(({ kind, content }) => [kind, content]),
		[
			[9, "Hello"],
			[40003, "Hello world"],
		],
	);
	assert.deepEqual(published[0]?.tags, [
		["h", "c"],
		["e", id("a"), "", "reply"],
	]);
	assert.deepEqual(published[1]?.tags, [
		["h", "c"],
		["e", id("1")],
	]);
	assert.ok(
		Math.floor((published[1]?.at ?? 0) / 1000) >
			Math.floor((published[0]?.at ?? 0) / 1000),
	);
	await reply.finish();
	assert.equal(published.length, 2, "unchanged text is not published again");
	assert.equal(reply.messageId(), id("1"));
});

test("a failed publish stops the stream and surfaces at the end", async () => {
	let clock = 0;
	const reply = createReply({
		channelId: "c",
		rootId: id("a"),
		intervalMs: 0,
		now: () => clock++,
		publish: async () => {
			throw new Error("This agent is no longer listening");
		},
	});
	reply.append("text");
	reply.append("more");
	await assert.rejects(reply.finish(), /no longer listening/);
});

test("without host.fetch the request goes through host.request", async () => {
	const seen: unknown[] = [];
	const fetch = hostFetch(() => ({
		runCommand: async () => null,
		request: async (input) => {
			seen.push(input);
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: "data: 1\n\n",
			};
		},
	}));
	const response = await fetch("https://api.example.test/v1", {
		method: "post",
		headers: { "X-Api-Key": "k" },
		body: "{}",
	});
	assert.deepEqual(seen, [
		{
			url: "https://api.example.test/v1",
			method: "POST",
			headers: { "x-api-key": "k" },
			body: "{}",
		},
	]);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "data: 1\n\n");
	await assert.rejects(
		fetch("https://api.example.test/v1", { signal: AbortSignal.abort() }),
	);
	assert.equal(seen.length, 1, "an aborted call never reaches the host");
});

test("host.fetch is used when the host has it, called on the host", async () => {
	const host = {
		runCommand: async () => null,
		request: async () => assert.fail("buffered path used"),
		marker: "host",
		async fetch(this: { marker: string }, input: RequestInfo | URL) {
			return new Response(`${this.marker} ${String(input)}`);
		},
	};
	const response = await hostFetch(() => host)("https://api.example.test/");
	assert.equal(await response.text(), "host https://api.example.test/");
});
