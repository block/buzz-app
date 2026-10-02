import { editTags, messageTags } from "./thread.ts";

export type Publish = (event: {
	kind: 9 | 40003;
	content: string;
	tags: string[][];
}) => Promise<{ id: string; created_at: number }>;

/** Shows text arriving in a channel, which has no token-stream event: the reply is
 * posted once, then edited as it grows. Publishes never overlap, and whatever
 * arrived during one goes out with the next. */
export function createReply(options: {
	publish: Publish;
	channelId: string;
	rootId: string;
	/** Least time between publishes while text is still arriving. */
	intervalMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}) {
	const {
		publish,
		channelId,
		rootId,
		intervalMs = 1500,
		now = Date.now,
		sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
	} = options;
	let text = "";
	let shown = "";
	let message: { id: string; created_at: number } | undefined;
	let editedAt = 0;
	let last = now();
	let busy: Promise<void> | undefined;
	let failure: unknown;

	async function flush() {
		const content = text.trim();
		if (!content || content === shown) return;
		last = now();
		if (!message) {
			message = await publish({
				kind: 9,
				content,
				tags: messageTags(channelId, rootId),
			});
			editedAt = message.created_at;
		} else {
			// The relay orders edits by created_at in whole seconds, so two edits signed
			// in the same second could leave the older text showing.
			const wait = (editedAt + 1) * 1000 - now();
			if (wait > 0) await sleep(wait);
			editedAt = (
				await publish({
					kind: 40003,
					content,
					tags: editTags(channelId, message.id),
				})
			).created_at;
		}
		shown = content;
	}

	return {
		/** The text so far, as the model wrote it. */
		text: () => text,
		/** The posted message, once there is one. */
		messageId: () => message?.id,
		append(delta: string) {
			text += delta;
			if (busy || failure || now() - last < intervalMs) return;
			busy = flush()
				.catch((error) => {
					failure = error;
				})
				.finally(() => {
					busy = undefined;
				});
		},
		/** Publishes the final text. Rejects if any publish failed. */
		async finish() {
			await busy;
			if (failure) throw failure;
			await flush();
		},
	};
}
