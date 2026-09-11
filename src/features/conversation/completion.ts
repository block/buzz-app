import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerObservation,
  CompletionContext,
  CompletionQuery,
  CompletionResult,
  CompletionSuggestion,
} from "./contracts";

export function matchCompletion(
  providers: readonly Contribution<ComposerCompletion>[],
  observation: ComposerObservation,
  context: CompletionContext,
) {
  const order = (value: ComposerCompletion) =>
    Number.isFinite(value.order) ? (value.order ?? 0) : 0;
  let winner:
    | { provider: Contribution<ComposerCompletion>; query: CompletionQuery }
    | undefined;
  for (const provider of [...providers].sort(
    (a, b) => order(a) - order(b) || a.key.localeCompare(b.key),
  )) {
    try {
      const query = provider.match(observation, context);
      // A later trigger owns the caret over a broad earlier query (e.g.
      // @Mary Jane :smile). Order/key resolve providers claiming the same start.
      if (
        validQuery(query, observation) &&
        (!winner || query.start > winner.query.start)
      )
        winner = {
          provider,
          query: Object.freeze({
            start: query.start,
            end: query.end,
            query: query.query,
          }),
        };
    } catch {
      /* A broken optional matcher cannot break editing. */
    }
  }
  return winner;
}
function validQuery(
  query: CompletionQuery | null,
  observation: ComposerObservation,
): query is CompletionQuery {
  return (
    !!query &&
    Number.isInteger(query.start) &&
    Number.isInteger(query.end) &&
    query.start >= 0 &&
    query.start < query.end &&
    query.end === observation.start &&
    observation.start === observation.end &&
    query.end <= observation.text.length &&
    typeof query.query === "string"
  );
}
/** Copy edit primitives so later provider mutation cannot retarget a displayed choice. */
export function completionResult(result: CompletionResult): CompletionResult {
  const ids = new Set<string>();
  const items: CompletionSuggestion[] = [];
  for (const item of (Array.isArray(result?.items) ? result.items : []).slice(
    0,
    50,
  )) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.label !== "string" ||
      !item.edit
    )
      continue;
    const edit = item.edit;
    if ("mention" in edit) {
      if (
        !edit.mention ||
        typeof edit.mention.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(edit.mention.pubkey) ||
        typeof edit.mention.name !== "string" ||
        !edit.mention.name.trim()
      )
        continue;
    } else if (
      typeof edit.text !== "string" ||
      !edit.text ||
      (edit.customEmoji &&
        !/^[a-z0-9_-]{1,64}$/.test(edit.customEmoji.shortcode))
    )
      continue;
    ids.add(item.id);
    items.push(
      Object.freeze({
        id: item.id,
        label: item.label,
        ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
        preview: item.preview,
        edit: Object.freeze(
          "mention" in edit
            ? { mention: Object.freeze({ ...edit.mention }) }
            : {
                text: edit.text,
                ...(edit.customEmoji
                  ? { customEmoji: Object.freeze({ ...edit.customEmoji }) }
                  : {}),
              },
        ),
      }),
    );
  }
  return Object.freeze({
    items: Object.freeze(items),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.retry === "function" ? { retry: result.retry } : {}),
  });
}
