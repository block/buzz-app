/** Brad's block/buzz 19da8950 contract. Presentation intent, never an ACL,
 * agent identity, recipient list, delivery receipt, or turn-completion signal. */
export type MessageAudience = "agents" | "everyone";
export function isMessageAudience(value: unknown): value is MessageAudience {
  return value === "agents" || value === "everyone";
}

/** Only a single exact declaration on a supported kind changes presentation.
 * Missing, malformed, duplicate and unknown declarations retain legacy behavior.
 * Unknown inputs also support inspecting reported prompt tags without trusting them. */
export function messageAudience(
  kind: unknown,
  tags: unknown,
): MessageAudience | undefined {
  if ((kind !== 9 && kind !== 45001 && kind !== 45003) || !Array.isArray(tags))
    return;
  const declarations = tags.filter(
    (tag) => Array.isArray(tag) && tag[0] === "audience",
  );
  const tag = declarations[0];
  return declarations.length === 1 &&
    tag.length === 2 &&
    isMessageAudience(tag[1])
    ? tag[1]
    : undefined;
}
