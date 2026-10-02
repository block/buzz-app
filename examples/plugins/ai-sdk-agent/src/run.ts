import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentDelivery } from "@buzz/author";
import { isStepCount, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { parseConfig, PROVIDERS, validate, type Config } from "./config.ts";
import { createReply } from "./reply.ts";
import { channelOf, fold, messageTags, threadRoot } from "./thread.ts";

type Filter = Readonly<{
	kinds?: readonly number[];
	ids?: readonly string[];
	"#h"?: readonly string[];
	"#e"?: readonly string[];
	limit: number;
}>;
type Stored = Parameters<typeof fold>[0][number];
/** What a run needs from the app besides the delivery itself. */
export type Surroundings = {
	/** Reaches the model provider. */
	fetch: typeof fetch;
	/** Reads as the agent's owner: the agent sees what its owner can see. */
	read(
		filters: readonly Filter[],
		signal: AbortSignal,
	): Promise<readonly Stored[]>;
	/** Display names for pubkeys; a pubkey with no known name is left out. */
	names(pubkeys: readonly string[]): Promise<ReadonlyMap<string, string>>;
	/** Time between edits of a reply while it streams in. */
	editIntervalMs?: number;
};

/** A run may read, think and write for this long before the app aborts it. */
export const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_STEPS = 8;
const MAX_AUX = 500;

function languageModel(config: Config, fetch: typeof globalThis.fetch) {
	const model = config.model.trim() || PROVIDERS[config.provider].model;
	const apiKey = config.apiKey.trim();
	return config.provider === "openai"
		? createOpenAI({ apiKey, fetch })(model)
		: createAnthropic({ apiKey, fetch })(model);
}

/** Answers one mention: the model's text streams into a reply in the mention's
 * thread, and its tools read and post in that channel. */
export async function run(
	delivery: AgentDelivery<unknown>,
	app: Surroundings,
): Promise<void> {
	const { event, agent, signal } = delivery;
	const problem = validate(delivery.config);
	if (problem) throw new Error(problem);
	const config = parseConfig(delivery.config);
	const channelId = delivery.channelId ?? channelOf(event);
	if (!channelId) throw new Error("The mention has no channel to answer in");
	const rootId = threadRoot(event);

	const named = async (pubkeys: readonly string[]) => {
		const names = await app
			.names(pubkeys)
			.catch(() => new Map<string, string>());
		return (pubkey: string) =>
			pubkey === agent.pubkey
				? `${agent.name} (you)`
				: (names.get(pubkey) ?? pubkey);
	};

	const tools = {
		read_messages: tool({
			description:
				"Read recent messages, oldest first: either the thread you were mentioned in, or the top level and replies of the whole channel.",
			inputSchema: z.object({
				scope: z.enum(["thread", "channel"]),
				limit: z.number().int().min(1).max(100).default(30),
			}),
			execute: async ({ scope, limit }) => {
				const found = await app.read(
					scope === "thread"
						? [
								{ ids: [rootId], limit: 1 },
								{ kinds: [9], "#h": [channelId], "#e": [rootId], limit },
							]
						: [{ kinds: [9], "#h": [channelId], limit }],
					signal,
				);
				const ids = found
					.filter((item) => item.kind === 9)
					.map((item) => item.id);
				const changes = ids.length
					? await app.read(
							[
								{
									kinds: [40003, 5],
									"#h": [channelId],
									"#e": ids,
									limit: MAX_AUX,
								},
							],
							signal,
						)
					: [];
				const messages = fold([...found, ...changes]);
				const name = await named([
					...new Set(messages.map((item) => item.pubkey)),
				]);
				return messages.map((item) => ({
					id: item.id,
					from: name(item.pubkey),
					pubkey: item.pubkey,
					at: new Date(item.created_at * 1000).toISOString(),
					...(item.thread ? { thread_id: item.thread } : {}),
					text: item.content,
				}));
			},
		}),
		post_message: tool({
			description:
				"Post a separate message in this channel as yourself. Not for your answer to the mention: that is posted for you.",
			inputSchema: z.object({
				content: z.string().min(1).describe("GitHub-flavored Markdown"),
				thread_id: z
					.string()
					.optional()
					.describe(
						"Id of the message to reply under. Omit for a new top-level message.",
					),
				mention_pubkeys: z
					.array(z.string())
					.max(8)
					.optional()
					.describe(
						"People to notify. Their names in the text alone do not notify.",
					),
			}),
			execute: async ({ content, thread_id, mention_pubkeys }) => {
				const posted = await agent.publish({
					kind: 9,
					content,
					tags: messageTags(channelId, thread_id, mention_pubkeys),
				});
				return { id: posted.id };
			},
		}),
	};

	const assistant = new ToolLoopAgent({
		model: languageModel(config, app.fetch),
		instructions: [
			config.instructions.trim(),
			`You are ${agent.name}, an agent in Buzz, a team chat app. Your pubkey is ${agent.pubkey}. You run when a message mentions you, and you see only that message unless you read more.`,
			"What you write is posted as your reply in the thread of that message, and shows up there while you write it. Use read_messages when the message depends on earlier conversation. Use post_message only for a separate message, never for the reply itself.",
		]
			.filter(Boolean)
			.join("\n\n"),
		tools,
		stopWhen: isStepCount(MAX_STEPS),
	});

	const reply = createReply({
		publish: agent.publish,
		channelId,
		rootId,
		...(app.editIntervalMs === undefined
			? {}
			: { intervalMs: app.editIntervalMs }),
	});
	try {
		const author = (await named([event.pubkey]))(event.pubkey);
		const result = await assistant.stream({
			prompt: `${author} (pubkey ${event.pubkey}) mentioned you in message ${event.id}:\n\n${event.content}`,
			abortSignal: signal,
		});
		for await (const part of result.fullStream) {
			if (part.type === "text-delta") reply.append(part.text);
			// Text from before a tool call and after it are separate paragraphs.
			else if (part.type === "text-start" && reply.text().trim())
				reply.append("\n\n");
			else if (part.type === "error") throw part.error;
		}
		await reply.finish();
	} catch (error) {
		// Say so where the person is waiting; the Agents page also counts the failure.
		const reason = String(error instanceof Error ? error.message : error);
		reply.append(
			`${reply.text().trim() ? "\n\n" : ""}⚠️ I couldn't finish: ${reason.slice(0, 300)}`,
		);
		await reply.finish().catch(() => {});
		throw error;
	}
}
