import type { EventData } from "./events";
import { threadReference } from "./thread-reference";

/** The signer's claim, in a signed `["thread-title", "1"]` tag, that a
 * top-level message is only its thread's title: the content is in the
 * replies. One well-formed claim, or none: a reply, another kind, another
 * value or a repeated tag claims nothing. */
export function threadTitleClaim(
  event: Pick<EventData, "kind" | "tags">,
): boolean {
  if (event.kind !== 9 || threadReference(event)) return false;
  const claims = event.tags.filter(([name]) => name === "thread-title");
  return claims.length === 1 && claims[0]?.length === 2 && claims[0][1] === "1";
}
