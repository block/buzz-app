import type { EventData } from "./events";

/** Signed candidate intent is distinct from notification (`p`) recipients. */
export const AGENT_CANDIDATE_TAG = "buzz:agent-candidate";

/** Persists the selected pool without waking unassigned agents. */
export function agentCandidateTags(
  candidates: readonly string[],
  assigned: readonly string[],
) {
  if (!candidates.length) return [];
  if (
    candidates.length > 32 ||
    candidates.some((key) => !/^[0-9a-f]{64}$/.test(key)) ||
    new Set(candidates).size !== candidates.length ||
    assigned.some((key) => !candidates.includes(key))
  )
    throw new Error("Invalid agent routing candidates");
  return candidates.map((key) => [AGENT_CANDIDATE_TAG, key]);
}

/** Display/selection intent only: future sends still recheck eligibility. */
export function agentCandidateMetadata(event: Pick<EventData, "tags">) {
  const candidates = event.tags
    .filter(([name]) => name === AGENT_CANDIDATE_TAG)
    .map((tag) => (tag.length === 2 ? tag[1] : undefined));
  const mentioned = event.tags
    .filter(([name]) => name === "p" || name === "mention")
    .map((tag) => tag[1]);
  const notified = event.tags
    .filter(([name]) => name === "p")
    .map((tag) => tag[1]);
  if (
    !candidates.length ||
    candidates.length > 32 ||
    new Set(candidates).size !== candidates.length ||
    notified.some((key) => !candidates.includes(key)) ||
    candidates.some(
      (key) => !key || !/^[0-9a-f]{64}$/.test(key) || !mentioned.includes(key),
    )
  )
    return {};
  return { agentCandidates: Object.freeze(candidates as string[]) };
}
