import type { Contribution } from "../../plugins/contributions";
import type {
  SendDraft,
  SendTransform,
  SendTransformContext,
} from "../conversation/contracts";

/** How long a plugin may take to transform a send before it fails. */
const SEND_TRANSFORM_TIMEOUT_MS = 10_000;

/** What a transform decided. `draft` is the message to send instead, or `null`
 * when it consumed the draft. `committed`: the plugin called `commit()`, so it
 * may have written; then a timeout, an abort or a failure no longer fails the
 * send. The draft is spent, with `notice` (still finishing) or `error` (it
 * threw) to tell the person. */
export type Transformed = Readonly<{
  draft: SendDraft | null;
  committed: boolean;
  notice?: string;
  error?: string;
}>;

/** The message `winner` sends instead, or `null` when it consumed the draft.
 * Its mentions are the draft's own entries, in the order it returned them: a
 * plugin can keep or drop the recipients the person addressed, never add one.
 * Before the plugin commits, it throws, naming the plugin, to block the send,
 * and settles when the send is aborted or the plugin takes longer than 10
 * seconds, even if it ignores `signal`; a late result is discarded. After it
 * commits, none of that throws: see `Transformed`. */
export async function transformSend(
  winner: Contribution<SendTransform>,
  draft: SendDraft,
  context: Omit<SendTransformContext, "commit">,
): Promise<Transformed> {
  const { signal } = context;
  signal.throwIfAborted();
  // The plugin's signal also aborts when it times out.
  const attempt = new AbortController();
  const state = { committed: false };
  const commit = () => {
    state.committed = true;
  };
  const timedOut = new Error("timed out");
  let stop = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      attempt.abort(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => {
      attempt.abort(timedOut);
      reject(timedOut);
    }, SEND_TRANSFORM_TIMEOUT_MS);
  });
  try {
    const result: unknown = await Promise.race([
      (async () =>
        winner.transform(draft, {
          ...context,
          signal: attempt.signal,
          commit,
        }))(),
      aborted,
    ]);
    signal.throwIfAborted();
    const sent = sendDraft(result);
    if (!sent) throw new Error(`${winner.title} returned an invalid message.`);
    const typed = new Map(draft.mentions.map((item) => [item.pubkey, item]));
    if (sent.keys.some((key) => !typed.has(key)))
      throw new Error(
        "returned a recipient you did not address. A transform can keep or drop the people you tagged, not add anyone.",
      );
    const mentions = [...new Set(sent.keys)].flatMap((key) => {
      const item = typed.get(key);
      return item ? [item] : [];
    });
    // Recipients need a message: Buzz never publishes one without text.
    if (!sent.text.trim()) {
      if (mentions.length)
        throw new Error(`${winner.title} returned an invalid message.`);
      return { draft: null, committed: state.committed };
    }
    return {
      draft: { text: sent.text, mentions },
      committed: state.committed,
    };
  } catch (reason) {
    if (state.committed) {
      // It may have written already, so the message counts as sent.
      if (reason === timedOut || signal.aborted)
        return {
          draft: null,
          committed: true,
          notice: `${winner.pluginId}: still finishing`,
        };
      return {
        draft: null,
        committed: true,
        error: failure(winner, reason),
      };
    }
    if (signal.aborted) throw reason;
    throw new Error(failure(winner, reason));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

const failure = (
  winner: Pick<Contribution<SendTransform>, "pluginId">,
  reason: unknown,
) =>
  `${winner.pluginId}: ${reason instanceof Error ? reason.message : String(reason)}`;

function sendDraft(
  value: unknown,
): { text: string; keys: readonly string[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { text, mentions } = value as Record<string, unknown>;
  if (typeof text !== "string" || !Array.isArray(mentions)) return undefined;
  // Read each key once: a getter or Proxy must not change after validation.
  const keys = mentions.map(
    (item: unknown) => ((item ?? {}) as Record<string, unknown>).pubkey,
  );
  return keys.every((key): key is string => typeof key === "string")
    ? { text, keys }
    : undefined;
}
