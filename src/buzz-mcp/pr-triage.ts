import type { BuzzClient, Context } from "./client";
import { REVIEW_SUBMISSION } from "../features/agents/pr-review";
import {
  TRIAGE_REPORT,
  latestTriageDecision,
  triageTarget,
  validateTriageDecision,
} from "../features/agents/pr-triage";

async function saveTriageDecision(
  client: BuzzClient,
  context: Context,
  args: Readonly<Record<string, unknown>>,
) {
  const decision = validateTriageDecision(args);
  const binding = context.review;
  if (!binding)
    throw new Error(
      "This host has not supplied a review turn. No triage decision was saved.",
    );
  const heads = await client.query([
    {
      kinds: [45010],
      "#h": [binding.channel],
      "#type": [REVIEW_SUBMISSION],
      artifact: "current",
      limit: 101,
    },
  ]);
  if (heads.length > 100)
    throw new Error("Too many submissions to resolve triage safely.");
  const matches = await Promise.allSettled(
    heads.map((head) =>
      triageTarget(head, binding.channel, binding.root, client.pubkey),
    ),
  );
  const targets = matches.flatMap((match) =>
    match.status === "fulfilled" ? [match.value] : [],
  );
  const target = targets[0];
  if (targets.length !== 1 || !target)
    throw new Error("This thread has no unique active triage assigned to you.");
  const current = async () => {
    const head = (
      await client.query([
        {
          kinds: [45010],
          "#h": [target.channel],
          "#d": [target.artifact],
          artifact: "current",
          limit: 1,
        },
      ])
    )[0];
    if (
      !head ||
      (await triageTarget(head, binding.channel, binding.root, client.pubkey))
        .request !== target.request
    )
      throw new Error(
        "The triage request changed. This decision cannot apply to a new submission.",
      );
  };
  const events = await client.query([
    {
      kinds: [9],
      authors: [client.pubkey],
      "#h": [target.channel],
      "#t": [TRIAGE_REPORT],
      "#r": [target.request],
      limit: 100,
      consistency: "strong",
    },
  ]);
  if (events.length >= 100)
    throw new Error("Triage history is incomplete. No decision was saved.");
  const previous = latestTriageDecision(events, target);
  await current();
  if (previous) {
    if (
      previous.decision !== decision.decision ||
      previous.message !== decision.message
    )
      throw new Error(
        "A final triage decision is already saved. Delete and resubmit the PR for a fresh triage.",
      );
    return `Triage decision already saved: ${previous.decision}.`;
  }
  client.signal?.throwIfAborted();
  await client.publish({
    kind: 9,
    content: decision.message,
    tags: [
      ["h", target.channel],
      ["e", target.root, "", "reply"],
      ["t", TRIAGE_REPORT],
      ["r", target.request],
      ["triage", target.artifact],
      ["decision", decision.decision],
    ],
  });
  await current();
  const confirmed = await client.query([
    {
      kinds: [9],
      authors: [client.pubkey],
      "#h": [target.channel],
      "#t": [TRIAGE_REPORT],
      "#r": [target.request],
      limit: 100,
      consistency: "strong",
    },
  ]);
  if (confirmed.length >= 100)
    throw new Error(
      "Triage history is incomplete. Decision confirmation failed.",
    );
  const saved = latestTriageDecision(confirmed, target);
  if (
    !saved ||
    saved.decision !== decision.decision ||
    saved.message !== decision.message
  )
    throw new Error(
      "Triage decision could not be confirmed. Retry the same decision.",
    );
  return `Triage decision saved: ${decision.decision}. Admission resumes through the submitter's connected Buzz client.`;
}

// A host may issue parallel calls for one turn. Serialize them, then confirm
// against the relay so competing hosts cannot both report opposite successes.
const pending = new Map<string, Promise<unknown>>();
export async function recordTriageDecision(
  client: BuzzClient,
  context: Context,
  args: Readonly<Record<string, unknown>>,
) {
  const key = `${client.pubkey}:${context.review?.channel}:${context.review?.root}`;
  const previous = pending.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => saveTriageDecision(client, context, args));
  pending.set(key, task);
  try {
    return await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}
