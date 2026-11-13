import type { BuzzClient, Context } from "./client";
import { npubEncode } from "nostr-tools/nip19";
import {
  REVIEW_REPORT,
  REVIEW_STATUSES,
  reviewLabels,
  type ReviewStatus,
  REVIEW_SUBMISSION,
  latestReport,
  reportStatus,
  reportSequence,
  reviewTarget,
} from "../features/agents/pr-review";

export async function updateReviewStatus(
  client: BuzzClient,
  context: Context,
  args: Readonly<Record<string, unknown>>,
) {
  if (
    Object.keys(args).some((key) => key !== "status") ||
    !REVIEW_STATUSES.includes(args.status as (typeof REVIEW_STATUSES)[number])
  )
    throw new Error(
      "Only status: reviewing, request_changes, lgtm_not_approved or approved is accepted. Buzz supplies the review target.",
    );
  const binding = context.review;
  if (!binding)
    throw new Error(
      "This host has not supplied a review turn. No status was changed.",
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
    throw new Error("Too many submissions to resolve this review safely.");
  const matches = await Promise.allSettled(
    heads.map((head) =>
      reviewTarget(head, binding.channel, binding.root, client.pubkey),
    ),
  );
  const targets = matches.flatMap((match) =>
    match.status === "fulfilled" ? [match.value] : [],
  );
  const target = targets[0];
  if (targets.length !== 1 || !target)
    throw new Error("This thread has no unique active review assigned to you.");
  const current = async () => {
    const head = (
      await client.query([
        {
          kinds: [45010],
          "#h": [binding.channel],
          "#d": [target.artifact],
          artifact: "current",
          limit: 1,
        },
      ])
    )[0];
    if (!head) throw new Error("The review submission is unavailable.");
    const latest = await reviewTarget(
      head,
      binding.channel,
      binding.root,
      client.pubkey,
    );
    if (
      latest.request !== target.request ||
      latest.autoApprove !== target.autoApprove
    )
      throw new Error(
        "The review changed during this update. No result applies to the new request.",
      );
  };
  const reports = await client.query([
    {
      kinds: [9],
      authors: [client.pubkey],
      "#h": [target.channel],
      "#t": [REVIEW_REPORT],
      "#r": [target.request],
      limit: 100,
      consistency: "strong",
    },
  ]);
  if (reports.length >= 100)
    throw new Error(
      "Review report history reached its read limit. Request a new review before reporting again.",
    );
  const previous = latestReport(reports, target);
  await current();
  if (
    args.status !== "reviewing" &&
    !reports.some((report) => reportStatus(report, target) === "reviewing")
  ) {
    const message =
      'Set reviewing first: call pr_review_status_update({"status":"reviewing"}) and wait for success, then review and report the outcome. No outcome was saved.';
    const corrections = await client.query([
      {
        kinds: [9],
        authors: [client.pubkey],
        "#h": [target.channel],
        "#t": ["buzz.review.sequence-correction"],
        "#r": [target.request],
        limit: 1,
        consistency: "strong",
      },
    ]);
    await current();
    if (!corrections.length) {
      client.signal?.throwIfAborted();
      await client.publish({
        kind: 9,
        tags: [
          ["h", target.channel],
          ["e", target.root, "", "reply"],
          ["p", target.reviewer],
          ["t", "buzz.review.sequence-correction"],
          ["r", target.request],
        ],
        content: `**Review step required** · [@Reviewer](nostr:${npubEncode(target.reviewer)})\n\nCall \`pr_review_status_update({"status":"reviewing"})\` and wait for success before reviewing and reporting an outcome. **No outcome was saved.**`,
      });
    }
    throw new Error(message);
  }
  if (args.status === "approved" && !target.autoApprove)
    throw new Error(
      "Automatic approval is disabled for this lane. Do not approve on GitHub; report lgtm_not_approved if the review looks good.",
    );
  if (previous && reportStatus(previous, target) === args.status)
    return `Review status already saved: ${args.status}.`;
  client.signal?.throwIfAborted();
  await client.publish({
    kind: 9,
    tags: [
      ["h", target.channel],
      ["e", target.root, "", "reply"],
      ["t", REVIEW_REPORT],
      ["r", target.request],
      ["review", target.artifact, String(target.index)],
      ["status", args.status as string],
      ["review-sequence", String(previous ? reportSequence(previous) + 1 : 1)],
    ],
    content: `Review status: ${reviewLabels[args.status as ReviewStatus]}.`,
  });
  // A reset can race publication. Its old request token is never projected into
  // the new round; tell the caller when that happened rather than claiming success.
  await current();
  return `Review status saved: ${args.status}.`;
}
