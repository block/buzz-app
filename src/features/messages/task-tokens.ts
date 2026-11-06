import {
  composerToken,
  composerTokenName,
  type ComposerToken,
} from "./composer-token";

export const TASK_TOKENS_TAG = "nexus.tokens.v1";
const MAX_BYTES = 16 * 1024;

function checked(value: unknown): readonly ComposerToken[] {
  if (!Array.isArray(value) || !value.length || value.length > 32)
    throw new Error("Choose between 1 and 32 task tokens.");
  const tokens = value.map(composerToken);
  if (tokens.some((token) => !token))
    throw new Error("A task token is invalid. Select it again.");
  const keys = new Set(
    tokens.map((token) =>
      JSON.stringify([
        token?.kind,
        token?.id,
        token?.kind === "nexus.skill" ? token.target : "",
      ]),
    ),
  );
  if (keys.size !== tokens.length)
    throw new Error("Remove duplicate task tokens before sending.");
  return tokens as readonly ComposerToken[];
}

export function taskTokenTags(tokens: readonly ComposerToken[]): string[][] {
  if (!tokens.length) return [];
  // Filing is personal composer metadata, never part of a signed task message.
  const references = checked(tokens).filter(
    (token) => token.kind !== "nexus.project",
  );
  if (!references.length) return [];
  const json = JSON.stringify(references);
  if (new TextEncoder().encode(json).length > MAX_BYTES)
    throw new Error("Task tokens are too large. Remove some before sending.");
  return [[TASK_TOKENS_TAG, json]];
}

let signing: readonly ComposerToken[] = [];
/** Host task composers only: the first message `send` or `reply` that
 * `publish` makes synchronously carries these chips. A send made while it is
 * queued, such as by an outbox subscriber, does not. The public message API
 * cannot add them; outbox preparation still checks them against the task chat
 * and recipients. */
export function signTaskTokens<T>(
  tokens: readonly ComposerToken[],
  publish: () => T,
): T {
  const previous = signing;
  signing = tokens;
  try {
    return publish();
  } finally {
    signing = previous;
  }
}
/** The tag for the chips `signTaskTokens` is publishing, if any. The first
 * caller takes them. */
export function signedTaskTokenTags() {
  const tokens = signing;
  signing = [];
  return taskTokenTags(tokens);
}

/** Unknown versions are inert. Never recover execution identity from prose. */
export function readTaskTokens(
  tags: readonly (readonly string[])[],
): readonly ComposerToken[] {
  const found = tags.filter(([name]) => name === TASK_TOKENS_TAG);
  if (!found.length) return [];
  const tag = found[0];
  if (
    found.length !== 1 ||
    tag?.length !== 2 ||
    typeof tag[1] !== "string" ||
    new TextEncoder().encode(tag[1]).length > MAX_BYTES
  )
    throw new Error("This message has invalid task tokens.");
  try {
    return checked(JSON.parse(tag[1]));
  } catch {
    throw new Error("This message has invalid task tokens.");
  }
}

/** Pre-inline wire form: compare existing signed recovery bytes only.
 * New publications keep literal references in their authored positions. */
export function taskTokenFallback(tokens: readonly ComposerToken[]) {
  return tokens
    .filter((token) => token.kind !== "nexus.project")
    .map((token) => {
      const label = composerTokenName(token);
      const fence = "`".repeat(
        Math.max(
          0,
          ...[...label.matchAll(/`+/g)].map((match) => match[0].length),
        ) + 1,
      );
      return `Task reference: ${fence} ${label} ${fence}`;
    })
    .join("\n");
}
