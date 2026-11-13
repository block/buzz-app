import { rememberTriage, forgetTriage } from "./triage-recovery";
import { admissionFailure, type ReadAdmission } from "./admission";
import {
  TRIAGE_REPORT,
  latestTriageDecision,
} from "../../features/agents/pr-triage";
import {
  REVIEW_REPORT,
  REVIEW_SUBMISSION,
  latestReport,
  reportStatus,
  reviewToken,
  type ReviewState,
} from "../../features/agents/pr-review";
import type { ReadPullStatus } from "./pull-facts";
import { laneMatches, type PullFacts } from "./routing";
import { npubEncode } from "nostr-tools/nip19";
import { profileMentionLink } from "../../features/messages/message-edit";
import {
  ARTIFACT_KIND,
  uuidv5,
} from "../../features/agents/agent-config-artifacts";
import { attestedOwner } from "../../features/agents/owner-attestation";
import type { EventData } from "../../features/relay/events";
import type { Outbox } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import {
  repositoryName,
  validateConfig,
  type ReviewConfig,
  type SavedReviewConfig,
} from "./configuration";

const TYPE = REVIEW_SUBMISSION;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/;
type Thread = {
  id?: string;
  started?: true;
  delivered?: true;
  request?: string;
};
export type Submission = {
  version: 1 | 2 | 3 | 4;
  triage?: {
    state: "pending" | "admitted" | "rejected";
    agent: string;
    instructions: string;
    head: string;
    base: string;
    reviewers: readonly string[];
    thread: Thread;
    decision?: string;
    message?: string;
  };
  generation?: string;
  submittedAt?: number;
  pr: number;
  config: ReviewConfig;
  configRevision: string;
  submitter: string;
  device: string;
  threads: Thread[];
  deleted?: true;
  notifying?: true;
  notifyingLane?: string;
  reminderMessage?: string;
};
export type SavedSubmission = {
  value: Submission;
  artifactId: string;
  revision: string;
  reviewStates?: ReviewState[];
  reviewReports?: EventData[];
  lastReviewedAt?: number;
  reviewHistoryIncomplete?: boolean;
};
const tag = (event: EventData, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];
const identity = (channel: string, repository: string, pr: number) =>
  uuidv5(channel, `${TYPE}:${repository}:${pr}`);
export const prUrl = (value: Submission) =>
  `https://github.com/${value.config.repository}/pull/${value.pr}`;
export const threadUrl = (channel: string, id: string) =>
  `buzz://message?channel=${channel}&id=${id}`;

/** A global PR entry requires a full URL so the configured repository is unambiguous. */
export function pullRepository(input: string): string {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/i.exec(
      input.trim(),
    );
  if (!match)
    throw new Error("Enter a full GitHub PR URL to find its repository.");
  const repository = repositoryName(match[1] ?? "");
  pullRequest(input, repository);
  return repository;
}

export function pullRequest(input: string, repository: string): number {
  const text = input.trim();
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/i.exec(text);
  if (match && repositoryName(match[1] ?? "") !== repository)
    throw new Error("This PR belongs to a different repository.");
  const number = /^(?:#)?[1-9]\d*$/.test(text)
    ? Number(text.replace(/^#/, ""))
    : match
      ? Number(match[2])
      : NaN;
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(
      "Enter a PR number or its full https://github.com pull request URL.",
    );
  return number;
}

export async function decodeSubmission(
  event: EventData,
  channel: string,
): Promise<SavedSubmission> {
  if (
    event.kind !== ARTIFACT_KIND ||
    tag(event, "h") !== channel ||
    tag(event, "type") !== TYPE
  )
    throw new Error("Unexpected review submission.");
  const value = JSON.parse(event.content) as Submission;
  const config = validateConfig(value.config);
  if (
    ![1, 2, 3, 4].includes(value.version) ||
    ((value.version === 3 || value.version === 4) &&
      (typeof value.generation !== "string" || !UUID.test(value.generation))) ||
    (value.submittedAt !== undefined &&
      (!Number.isSafeInteger(value.submittedAt) ||
        value.submittedAt <= 0 ||
        value.submittedAt > 8_640_000_000_000)) ||
    !Number.isSafeInteger(value.pr) ||
    value.pr < 1 ||
    value.submitter !== event.pubkey ||
    !HEX.test(value.configRevision) ||
    !UUID.test(value.device) ||
    (value.deleted !== undefined && value.deleted !== true) ||
    (value.notifying !== undefined && value.notifying !== true) ||
    (value.reminderMessage !== undefined &&
      (!value.notifying ||
        typeof value.reminderMessage !== "string" ||
        value.reminderMessage.length > 4000)) ||
    (value.notifyingLane !== undefined &&
      (!value.notifying ||
        !config.lanes.some((lane) => lane.id === value.notifyingLane))) ||
    (!(value.version === 4 && value.triage?.state !== "admitted") &&
      config.lanes.some((lane) => lane.reviewers.length !== 1)) ||
    !Array.isArray(value.threads) ||
    value.threads.length !==
      (value.version === 4 && value.triage?.state !== "admitted"
        ? 0
        : config.lanes.length + (value.version === 1 ? 1 : 0)) ||
    value.threads.some(
      (thread) =>
        !thread ||
        (thread.started !== undefined && thread.started !== true) ||
        (thread.request !== undefined &&
          (typeof thread.request !== "string" ||
            !reviewToken.test(thread.request))) ||
        (thread.id !== undefined && !HEX.test(thread.id)) ||
        (thread.delivered !== undefined &&
          (thread.delivered !== true || !thread.id)),
    )
  )
    throw new Error("Invalid review submission.");
  if (value.version === 4) {
    const triage = value.triage;
    if (
      !triage ||
      !["pending", "admitted", "rejected"].includes(triage.state) ||
      !HEX.test(triage.agent) ||
      typeof triage.instructions !== "string" ||
      !triage.instructions.trim() ||
      triage.instructions.length > 8000 ||
      !/^[0-9a-f]{40,64}$/.test(triage.head) ||
      !/^[0-9a-f]{40,64}$/.test(triage.base) ||
      !Array.isArray(triage.reviewers) ||
      triage.reviewers.length > 12 ||
      triage.reviewers.some(
        (key) => typeof key !== "string" || (key !== "" && !HEX.test(key)),
      ) ||
      !triage.thread ||
      !reviewToken.test(triage.thread.request ?? "") ||
      (triage.thread.id !== undefined && !HEX.test(triage.thread.id)) ||
      (triage.thread.started !== undefined && triage.thread.started !== true) ||
      (triage.thread.delivered !== undefined &&
        (triage.thread.delivered !== true || !triage.thread.id)) ||
      (triage.decision !== undefined && !HEX.test(triage.decision)) ||
      (triage.message !== undefined &&
        (typeof triage.message !== "string" || triage.message.length > 4000)) ||
      (triage.state !== "pending" && (!triage.decision || !triage.message)) ||
      (triage.state === "pending" &&
        (triage.decision !== undefined || triage.message !== undefined))
    )
      throw new Error("Invalid triage submission.");
  } else if (value.triage !== undefined)
    throw new Error("Unexpected triage state.");
  const artifactId = await identity(channel, config.repository, value.pr);
  if (tag(event, "d") !== artifactId)
    throw new Error("Invalid submission identity.");
  return { value: { ...value, config }, artifactId, revision: event.id };
}

export async function loadSubmissions(
  session: RelaySession,
  channel: string,
  signal: AbortSignal,
) {
  if (!session.snapshotRead)
    throw new Error("This connection cannot read submissions.");
  const events = await session.snapshotRead(
    [
      {
        kinds: [ARTIFACT_KIND],
        "#h": [channel],
        "#type": [TYPE],
        artifact: "current",
        limit: 101,
      },
    ],
    { signal },
  );
  const results = await Promise.allSettled(
    events.slice(0, 100).map((event) => decodeSubmission(event, channel)),
  );
  const rows = results.flatMap((result) =>
    result.status === "fulfilled" && !result.value.value.deleted
      ? [result.value]
      : [],
  );
  const roots = rows.flatMap((row) =>
    row.value.threads.flatMap((thread) => (thread.id ? [thread.id] : [])),
  );
  const reports: EventData[] = [];
  let reviewHistoryIncomplete = false;
  // The app reader caps a page at 500. Batch thread roots and refuse a full
  // page rather than turning an incomplete snapshot into Needs review.
  for (let offset = 0; offset < roots.length; offset += 100) {
    const page = await session.snapshotRead(
      [
        {
          kinds: [9],
          "#h": [channel],
          "#t": [REVIEW_REPORT],
          "#e": roots.slice(offset, offset + 100),
          limit: 500,
        },
      ],
      { signal },
    );
    if (page.length >= 500) reviewHistoryIncomplete = true;
    reports.push(...page);
  }
  if (reviewHistoryIncomplete) {
    // Long review history must not prevent loading the current outcome.
    reports.length = 0;
    const requests = rows.flatMap((row) =>
      row.value.threads.flatMap((thread) =>
        thread.request ? [thread.request] : [],
      ),
    );
    for (let offset = 0; offset < requests.length; offset += 100) {
      const page = await session.snapshotRead(
        [
          {
            kinds: [9],
            "#h": [channel],
            "#t": [REVIEW_REPORT],
            "#r": requests.slice(offset, offset + 100),
            limit: 500,
          },
        ],
        { signal },
      );
      if (page.length >= 500)
        throw new Error(
          "Review report read reached its limit. Status could not be loaded completely.",
        );
      reports.push(...page);
    }
  }
  return {
    rows: rows.map((row) =>
      applyReviewReports(
        {
          ...row,
          ...(reviewHistoryIncomplete ? { reviewHistoryIncomplete: true } : {}),
        },
        channel,
        reports,
      ),
    ),
    warning: [
      reviewHistoryIncomplete
        ? "Review history reached its limit. Current statuses are shown; last-reviewed dates are unavailable."
        : "",
      events.length > 100
        ? "Showing results from the latest 100 saved records, including deleted entries."
        : "",
      results.some((result) => result.status === "rejected")
        ? "Some saved submissions could not be read."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Shared projection for the initial snapshot and verified live reports. */
export function applyReviewReports(
  row: SavedSubmission,
  channel: string,
  events: readonly EventData[],
): SavedSubmission {
  const reports = [...(row.reviewReports ?? []), ...events];
  const latest: EventData[] = [];
  let lastReviewedAt = row.lastReviewedAt;
  const reviewStates = row.value.threads.map((thread, index): ReviewState => {
    const lane = submissionLane(row.value, index);
    if (!thread.request || !thread.id || !lane) return "need_review";
    const target = {
      channel,
      artifact: row.artifactId,
      request: thread.request,
      root: thread.id,
      reviewer: lane.reviewers[0] ?? "",
      autoApprove: lane.autoApprove === true,
      index,
    };
    // Earlier rounds in the same assigned thread still establish the review date.
    // Current status continues to require the current request token.
    for (const event of reports) {
      const request = tag(event, "r");
      if (!request || !reviewToken.test(request)) continue;
      const status = reportStatus(event, { ...target, request });
      if (status && status !== "reviewing")
        lastReviewedAt = Math.max(lastReviewedAt ?? 0, event.created_at);
    }
    const report = latestReport(reports, target);
    if (!report) return "need_review";
    latest.push({ ...report, tags: report.tags.map((tag) => [...tag]) });
    return reportStatus(report, target) ?? "need_review";
  });
  return {
    ...row,
    reviewStates,
    reviewReports: latest,
    ...(lastReviewedAt ? { lastReviewedAt } : {}),
  };
}

async function write(
  session: RelaySession,
  channel: string,
  value: Submission,
  previous: SavedSubmission | undefined,
  signal: AbortSignal,
): Promise<SavedSubmission> {
  const writer = session.configArtifactWriter;
  if (!writer) throw new Error("This connection cannot save submissions.");
  signal.throwIfAborted();
  const artifactId = await identity(channel, value.config.repository, value.pr);
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify(value),
      tags: [
        ["ar", "1"],
        ["d", artifactId],
        ["h", channel],
        ["type", TYPE],
        ["title", `Review: ${value.config.repository}#${value.pr}`],
        ["op", previous ? "update" : "create"],
        ...(previous ? [["prev", previous.revision]] : []),
      ],
    },
    signal,
  );
  if (
    value.triage &&
    !value.deleted &&
    value.triage.state !== "rejected" &&
    (value.triage.state === "pending" ||
      value.threads.some((thread) => !thread.delivered))
  )
    rememberTriage(session.scope, { channel, artifact: artifactId });
  await writer.publish(event, signal);
  if (
    value.triage &&
    (value.deleted ||
      value.triage.state === "rejected" ||
      (value.triage.state === "admitted" &&
        value.threads.every((thread) => thread.delivered)))
  )
    forgetTriage(session.scope, artifactId);
  return { value, artifactId, revision: event.id };
}

/** Remove from the shared list. A later submission creates fresh lane threads. */
export async function deleteSubmission(
  session: RelaySession,
  channel: string,
  previous: SavedSubmission,
  signal: AbortSignal,
) {
  if (!session.viewer || previous.value.submitter !== session.viewer)
    throw new Error("Only the original submitter can delete this submission.");
  const read = session.snapshotRead;
  if (!read || !navigator.locks)
    throw new Error("Submission deletion is unavailable.");
  return navigator.locks.request(
    `buzz.review.submit:${session.scope}`,
    { signal },
    async () => {
      const events = await read(
        [
          {
            kinds: [ARTIFACT_KIND],
            "#h": [channel],
            "#d": [previous.artifactId],
            artifact: "current",
            limit: 1,
          },
        ],
        { signal },
      );
      const head = events[0];
      if (!head) throw new Error("Submission is unavailable. Reload the list.");
      const current = await decodeSubmission(head, channel);
      if (current.value.submitter !== session.viewer)
        throw new Error(
          "Only the original submitter can delete this submission.",
        );
      if (current.revision !== previous.revision)
        throw new Error("Submission changed. Reload the list before deleting.");
      await write(
        session,
        channel,
        { ...current.value, deleted: true },
        current,
        signal,
      );
    },
  );
}

/** Device ownership is recovery coordination, never permission. The relay still
 * authorizes every write. Shared Web Locks serialize tabs; artifact create/CAS
 * serializes devices. Losing this profile cannot authorize replacement sends. */
export function deviceId(scope: string) {
  const key = `buzz.review.device:${scope}`;
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  if (!UUID.test(value))
    throw new Error("Submission recovery storage is unavailable.");
  return value;
}

export function submissionLane(value: Submission, index: number) {
  return value.config.lanes[index - (value.version === 1 ? 1 : 0)];
}

export function deliveryThreads(value: Submission): Thread[] {
  return value.triage?.state === "pending"
    ? [value.triage.thread]
    : value.threads;
}
function replaceDeliveryThread(
  value: Submission,
  index: number,
  thread: Thread,
): Submission {
  return value.triage?.state === "pending"
    ? { ...value, triage: { ...value.triage, thread } }
    : {
        ...value,
        threads: value.threads.map((item, i) => (i === index ? thread : item)),
      };
}
export function threadMessage(
  value: Submission,
  channel: string,
  index: number,
  reviewerName = "Reviewer",
  documentation = "",
) {
  if (value.triage?.state === "pending") {
    const triage = value.triage;
    return {
      kind: 9,
      tags: [
        ["h", channel],
        ["subject", `${value.config.repository}#${value.pr} · Triage`],
        ["p", triage.agent],
      ],
      content: `Triage request: ${prUrl(value)}\n\nTriage agent: ${profileMentionLink(`@${reviewerName}`, `nostr:${npubEncode(triage.agent)}`)}\nCommit: ${triage.head}\n\n${triage.instructions}\n\n${documentation}\n\nCheck this PR before admitting it to review. Explain your decision in the tool message. Admission does not close or modify the GitHub PR.`,
    };
  }
  const lane = submissionLane(value, index);
  const title = `${value.config.repository}#${value.pr}${lane ? ` · ${lane.name}` : " · Review"}`;
  return {
    kind: 9,
    tags: [
      ["h", channel],
      ["subject", title],
      ...(lane ? [["p", lane.reviewers[0] ?? ""]] : []),
    ],
    content: lane
      ? `**Review request:** ${prUrl(value)}

${profileMentionLink(`@${reviewerName}`, `nostr:${npubEncode(lane.reviewers[0] ?? "")}`)} · ${lane.name}
${
  value.reminderMessage
    ? `
**Your reminder message**

${value.reminderMessage
  .split("\n")
  .map((line) => `> ${line}`)
  .join("\n")}
`
    : ""
}
**Lane instructions**

${lane.instructions}

${lane.autoApprove ? "**AUTOMATIC APPROVAL: ALLOWED FOR THIS LANE.** Approve only after reviewing the current commit." : "**AUTOMATIC APPROVAL: OFF — DO NOT APPROVE THIS PR ON GITHUB.**"} **Never merge.**

**Required steps**

${documentation || 'First call `pr_review_status_update({"status":"reviewing"})` and wait for success, even for acknowledgment-only requests. After reviewing, post the commit, findings and blockers; report `request_changes`, `lgtm_not_approved`, or `approved` only after a permitted GitHub approval succeeds.'}

Add your authenticated GitHub account to requested reviewers, preserving others. If you are the author, lack access, or your runtime forbids it, explain and continue.${value.version === 1 ? `\n\nOverview: ${threadUrl(channel, value.threads[0]?.id ?? "")}` : ""}`
      : `Review request: ${prUrl(value)}\n\nLanes: ${value.config.lanes.map((item) => item.name).join(", ")}\n\nLane threads and delivery status are listed in Review Configuration. A delivered request does not mean the reviewer has started. Automatic reminders are off.`,
  };
}

async function eligible(
  session: RelaySession,
  value: Submission,
  signal: AbortSignal,
) {
  await session.agentChoices.refresh(true, { fresh: true });
  signal.throwIfAborted();
  const choices = session.agentChoices.snapshot();
  if (choices.archives.status !== "ready" || choices.archives.error)
    throw new Error(
      "Refresh agents after archive access is restored before submitting.",
    );
  const keys = [
    ...new Set(
      value.triage?.state === "pending"
        ? [value.triage.agent]
        : value.config.lanes.map((lane) => lane.reviewers[0] ?? ""),
    ),
  ];
  if (
    keys.some(
      (key) => !choices.selectable.some((choice) => choice.pubkey === key),
    )
  )
    throw new Error(
      "A selected reviewer is unavailable. Update the saved reviewer assignments.",
    );
  if (!session.snapshotRead)
    throw new Error("Submission reads are unavailable.");
  const profiles = await session.snapshotRead(
    [{ kinds: [0], authors: keys, limit: keys.length, consistency: "strong" }],
    { signal },
  );
  for (const key of keys) {
    const profile = profiles
      .filter((event) => event.kind === 0 && event.pubkey === key)
      .sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0];
    if (!profile || (await attestedOwner(profile)) !== session.viewer)
      throw new Error(
        "Submission currently requires reviewers with verified ownership by your signed-in identity.",
      );
  }
}

function delivered(
  outbox: Outbox,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () =>
      finish(
        new Error(
          "Delivery was interrupted. Resume this submission to check its saved messages.",
        ),
      );
    const check = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      if (!item)
        return finish(
          new Error(
            "Reload this page to recover delivery from the shared outbox.",
          ),
        );
      if (item.delivery === "accepted" || item.delivery === "seen") finish();
      else if (item.delivery === "failed" || item.delivery === "unknown")
        finish(
          new Error(
            item.error ??
              "Delivery is unconfirmed. Resume to retry the same message.",
          ),
        );
    };
    stop = outbox.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

/** Explicit resubmission mentions the saved reviewer in each existing lane thread.
 * Keep receipts until the whole batch succeeds so interrupted sends can resume. */
async function notifyReviewers(
  session: RelaySession,
  channel: string,
  record: SavedSubmission,
  signal: AbortSignal,
  reminder = false,
  documentation = "",
  laneId?: string,
  message = "",
) {
  const outbox = session.outbox;
  if (!outbox) throw new Error("Message delivery is unavailable.");
  if (laneId && !record.value.config.lanes.some((lane) => lane.id === laneId))
    throw new Error("Review lane is unavailable. Reload the list.");
  if (record.value.notifying && record.value.notifyingLane !== laneId)
    throw new Error(
      "Finish the pending reminder before reminding another lane.",
    );
  await eligible(
    session,
    laneId
      ? {
          ...record.value,
          config: {
            ...record.value.config,
            lanes: record.value.config.lanes.filter(
              (lane) => lane.id === laneId,
            ),
          },
        }
      : record.value,
    signal,
  );
  if (record.value.submitter !== session.viewer)
    throw new Error("Only the original submitter can request another review.");
  const device = deviceId(session.scope);
  if (record.value.notifying && record.value.device !== device)
    throw new Error(
      "Resume the pending notification from its original browser profile.",
    );
  if (!record.value.notifying)
    record = await write(
      session,
      channel,
      {
        ...record.value,
        notifying: true,
        reminderMessage: message.trim(),
        ...(laneId ? { notifyingLane: laneId } : {}),
        device,
        threads: record.value.threads.map((thread, index) =>
          submissionLane(record.value, index) &&
          (!laneId || submissionLane(record.value, index)?.id === laneId)
            ? { ...thread, request: crypto.randomUUID() }
            : thread,
        ),
      },
      record,
      signal,
    );
  const receipts: string[] = [];
  for (const [index, thread] of record.value.threads.entries()) {
    const lane = submissionLane(record.value, index);
    if (!lane || !thread.id) continue; // Older submissions also have an overview.
    if (laneId && lane.id !== laneId) continue;
    signal.throwIfAborted();
    const key = `review-notify:${record.artifactId}:${thread.id}:${thread.request}`;
    const recovery = await outbox.recovery(key);
    const active = () => !signal.aborted;
    let id: string;
    if (recovery) {
      id = recovery.event.id;
      if (!outbox.snapshot().some((item) => item.event.id === id))
        throw new Error("Reload to recover the saved reviewer notification.");
      if (!["accepted", "seen", "sending"].includes(recovery.delivery))
        outbox.retry(id, active);
    } else {
      const request = threadMessage(
        record.value,
        channel,
        index,
        session.agentChoices
          .snapshot()
          .selectable.find((choice) => choice.pubkey === lane.reviewers[0])
          ?.name,
        documentation,
      );
      id = outbox.send(
        {
          kind: 9,
          tags: [
            ["h", channel],
            ["e", thread.id, "", "reply"],
            ["p", lane.reviewers[0] ?? ""],
          ],
          content: request.content.replace(
            "**Review request:**",
            reminder ? "**Review reminder.**" : "**Review requested again:**",
          ),
        },
        { key, value: record.artifactId },
        active,
      );
    }
    await delivered(outbox, id, signal);
    receipts.push(id);
  }
  const {
    notifying: _notifying,
    notifyingLane: _notifyingLane,
    reminderMessage: _reminderMessage,
    ...value
  } = record.value;
  const completed = await write(session, channel, value, record, signal);
  for (const id of receipts) await outbox.acknowledge(id);
  return completed;
}

/** An explicit reminder uses only the current, fully delivered submission. */
export async function remindSubmission(
  session: RelaySession,
  channel: string,
  previous: SavedSubmission,
  signal: AbortSignal,
  readStatus: ReadPullStatus,
  documentation = "",
  laneId?: string,
  message = "",
) {
  if (typeof message !== "string" || message.length > 4000)
    throw new Error("Reminder message must be at most 4,000 characters.");
  const read = session.snapshotRead;
  const outbox = session.outbox;
  if (!read || !outbox?.supports(9) || !navigator.locks)
    throw new Error("Reviewer reminders are unavailable on this client.");
  if (!session.viewer || previous.value.submitter !== session.viewer)
    throw new Error("Only the original submitter can remind these reviewers.");
  return navigator.locks.request(
    `buzz.review.submit:${session.scope}`,
    { signal },
    async () => {
      await outbox.ready();
      const events = await read(
        [
          {
            kinds: [ARTIFACT_KIND],
            "#h": [channel],
            "#d": [previous.artifactId],
            artifact: "current",
            limit: 1,
          },
        ],
        { signal },
      );
      const head = events[0];
      if (!head) throw new Error("Submission is unavailable. Reload the list.");
      const current = await decodeSubmission(head, channel);
      if (current.revision !== previous.revision || current.value.deleted)
        throw new Error(
          "Submission changed. Reload the list before reminding.",
        );
      if (current.value.submitter !== session.viewer)
        throw new Error(
          "Only the original submitter can remind these reviewers.",
        );
      if (current.value.triage && current.value.triage.state !== "admitted")
        throw new Error("This PR has not been admitted to review.");
      if (!current.value.threads.every((thread) => thread.delivered))
        throw new Error(
          "Delivery is incomplete. Submit this PR again to finish delivery first.",
        );
      const status = await readStatus(
        current.value.config.repository,
        current.value.pr,
        signal,
      );
      signal.throwIfAborted();
      if (status !== "Open" && status !== "Draft")
        throw new Error(
          "This PR is closed or merged. Reviewers were not reminded.",
        );
      return notifyReviewers(
        session,
        channel,
        current,
        signal,
        true,
        documentation,
        laneId,
        message,
      );
    },
  );
}

function routeConfig(
  config: ReviewConfig,
  reviewers: readonly string[],
  facts?: PullFacts,
): ReviewConfig {
  const matched = config.lanes.flatMap((lane, i) =>
    !facts || laneMatches(lane.routing, facts) ? [{ lane, i }] : [],
  );
  if (!matched.length)
    throw new Error("No lanes match this PR. No review requests were sent.");
  return validateConfig({
    ...config,
    lanes: matched.map(({ lane, i }) => {
      const reviewer = reviewers[i];
      if (!reviewer || !lane.reviewers.includes(reviewer))
        throw new Error(`Choose a configured reviewer for ${lane.name}.`);
      return { ...lane, reviewers: [reviewer] };
    }),
  });
}
async function checkAdmission(
  config: ReviewConfig,
  facts: PullFacts | undefined,
  read: ReadAdmission | undefined,
  signal: AbortSignal,
) {
  const checks = config.admission;
  if (!checks || !(checks.ready || checks.ci || checks.conflicts)) return;
  if (!facts || !read)
    throw new Error(
      "Admission checks are unavailable. Reload before submitting.",
    );
  const checked = await read(config.repository, facts.pr, checks, signal);
  if (checked.head !== facts.head)
    throw new Error("The PR changed while checking admission. Try again.");
  const failure = admissionFailure(checks, checked);
  if (failure) throw new Error(`Admission rejected: ${failure}`);
}

/** Submission and owner-side triage recovery share the same lock and outbox journal. */
export async function submitReview(
  session: RelaySession,
  channel: string,
  saved: SavedReviewConfig,
  input: string,
  reviewers: readonly string[],
  signal: AbortSignal,
  onProgress: (value: SavedSubmission) => void,
  resume = false,
  facts?: PullFacts | (() => Promise<PullFacts>),
  notifyExisting?: () => void,
  documentation = "",
  admission?: {
    read: ReadAdmission;
    documentation: string;
    existingOnly?: boolean;
  },
) {
  const outbox = session.outbox;
  const read = session.snapshotRead;
  if (!outbox?.supports(9) || !read || !navigator.locks)
    throw new Error(
      "This client cannot submit reviews. Use a client with durable message delivery.",
    );
  if (!session.viewer) throw new Error("Sign in before submitting a review.");
  const viewer = session.viewer;
  const pr = pullRequest(input, saved.config.repository);
  const artifactId = await identity(channel, saved.config.repository, pr);
  return navigator.locks.request(
    `buzz.review.submit:${session.scope}`,
    { signal },
    async () => {
      const device = deviceId(session.scope);
      await outbox.ready();
      const events = await read(
        [
          {
            kinds: [ARTIFACT_KIND],
            "#h": [channel],
            "#d": [artifactId],
            artifact: "current",
            limit: 1,
          },
        ],
        { signal },
      );
      let record: SavedSubmission;
      const head = events[0];
      const previous = head ? await decodeSubmission(head, channel) : undefined;
      const existing = previous && !previous.value.deleted;
      if (admission?.existingOnly && !existing) {
        if (
          previous?.value.submitter === viewer &&
          previous.value.device === device
        )
          forgetTriage(session.scope, artifactId);
        throw new Error("Submission was removed. Recovery stopped.");
      }
      if (existing) {
        record = previous;
        if (
          admission?.existingOnly &&
          record.value.submitter === viewer &&
          record.value.device === device &&
          (record.value.triage?.state === "rejected" ||
            (record.value.triage?.state === "admitted" &&
              record.value.threads.every((thread) => thread.delivered)))
        ) {
          forgetTriage(session.scope, artifactId);
          return record;
        }
        notifyExisting?.();
      } else {
        if (previous && previous.value.submitter !== viewer)
          throw new Error(
            "Only the original submitter can resubmit this deleted submission.",
          );
        const currentFacts =
          typeof facts === "function" ? await facts() : facts;
        signal.throwIfAborted();
        if (
          currentFacts &&
          (currentFacts.repository !== saved.config.repository ||
            currentFacts.pr !== pr)
        )
          throw new Error("The loaded PR does not match this submission.");
        if (
          !currentFacts &&
          saved.config.lanes.some((lane) => lane.routing?.rules.length)
        )
          throw new Error("Load PR details before routing this submission.");
        await checkAdmission(
          saved.config,
          currentFacts,
          admission?.read,
          signal,
        );
        const triaging = saved.config.admission?.triage;
        if (triaging && (!currentFacts || !admission?.documentation))
          throw new Error(
            "Triage reporting is unavailable. Update Buzz before submitting.",
          );
        const config = triaging
          ? validateConfig(saved.config)
          : routeConfig(saved.config, reviewers, currentFacts);
        const value: Submission = {
          version: triaging ? 4 : previous ? 3 : 2,
          submittedAt: Math.floor(Date.now() / 1000),
          ...(previous || triaging ? { generation: crypto.randomUUID() } : {}),
          ...(triaging && currentFacts && saved.config.admission
            ? {
                triage: {
                  state: "pending" as const,
                  agent: saved.config.admission.agent,
                  instructions: saved.config.admission.instructions,
                  head: currentFacts.head,
                  base: currentFacts.base,
                  reviewers: [...reviewers],
                  thread: { request: crypto.randomUUID() },
                },
              }
            : {}),
          pr,
          config,
          configRevision: saved.revision,
          submitter: viewer,
          device,
          threads: Array.from(
            { length: triaging ? 0 : config.lanes.length },
            () => ({
              request: crypto.randomUUID(),
            }),
          ),
        };
        await eligible(session, value, signal);
        record = await write(session, channel, value, previous, signal);
      }
      if (
        record.value.triage?.state === "pending" &&
        record.value.triage.thread.delivered
      ) {
        const triage = record.value.triage;
        if (!triage.thread.request || !triage.thread.id)
          throw new Error("Missing triage thread identity.");
        const reports = await read(
          [
            {
              kinds: [9],
              authors: [triage.agent],
              "#h": [channel],
              "#t": [TRIAGE_REPORT],
              "#r": [triage.thread.request],
              limit: 100,
              consistency: "strong",
            },
          ],
          { signal },
        );
        if (reports.length >= 100)
          throw new Error("Triage history is incomplete. Routing stopped.");
        const decision = latestTriageDecision(reports, {
          channel,
          artifact: record.artifactId,
          request: triage.thread.request,
          root: triage.thread.id,
          reviewer: triage.agent,
        });
        if (decision) {
          if (
            record.value.submitter !== viewer ||
            record.value.device !== device
          )
            throw new Error(
              "Resume triage from the original submitting browser profile.",
            );
          let message = decision.message;
          let config = record.value.config;
          let admitted = decision.decision === "admit";
          if (admitted) {
            const currentFacts =
              typeof facts === "function" ? await facts() : facts;
            if (
              !currentFacts ||
              currentFacts.repository !== config.repository ||
              currentFacts.pr !== pr
            )
              throw new Error("Reload PR details before continuing triage.");
            if (
              currentFacts.head !== triage.head ||
              currentFacts.base !== triage.base
            ) {
              admitted = false;
              message =
                "The PR changed during triage. Delete and resubmit for a fresh decision.";
            } else {
              await checkAdmission(
                config,
                currentFacts,
                admission?.read,
                signal,
              );
              config = routeConfig(config, triage.reviewers, currentFacts);
            }
          }
          const value: Submission = {
            ...record.value,
            config,
            triage: {
              ...triage,
              state: admitted ? "admitted" : "rejected",
              decision: decision.id,
              message,
            },
            threads: admitted
              ? config.lanes.map(() => ({ request: crypto.randomUUID() }))
              : [],
          };
          if (admitted) await eligible(session, value, signal);
          record = await write(session, channel, value, record, signal);
        }
      }
      onProgress(record);
      if (record.value.triage?.state === "rejected") return record;
      if (
        record.value.triage?.state === "pending" &&
        record.value.triage.thread.delivered
      )
        return record;
      // The dedicated Submit action may notify; passive readers never dispatch.
      if (existing && !resume && !notifyExisting) return record;
      if (deliveryThreads(record.value).every((thread) => thread.delivered)) {
        if (existing && notifyExisting)
          record = await notifyReviewers(
            session,
            channel,
            record,
            signal,
            false,
            documentation,
          );
        for (const thread of deliveryThreads(record.value))
          if (thread.id) await outbox.acknowledge(thread.id);
        return record;
      }
      if (
        record.value.submitter !== session.viewer ||
        record.value.device !== device
      )
        throw new Error(
          "This PR is already submitted. Resume incomplete delivery from the original browser profile; existing threads remain available here.",
        );
      if (existing) await eligible(session, record.value, signal);
      for (const [index, thread] of deliveryThreads(record.value).entries()) {
        signal.throwIfAborted();
        // Keep legacy recovery keys readable, but isolate each post-delete review.
        const key =
          record.value.version === 3 || record.value.version === 4
            ? `${artifactId}:${record.value.generation}:${record.value.triage?.state === "pending" ? "triage" : index}`
            : `${artifactId}:${index}`;
        if (thread.delivered) {
          if (thread.id) await outbox.acknowledge(thread.id);
          continue;
        }
        const recovery = await outbox.recovery(key);
        let id = thread.id ?? recovery?.event.id;
        if (thread.id && recovery && thread.id !== recovery.event.id)
          throw new Error(
            "Submission recovery does not match the saved thread. Delivery stopped.",
          );
        if (id && !recovery) {
          const messages = await read(
            [
              {
                ids: [id],
                kinds: [9],
                "#h": [channel],
                limit: 1,
                consistency: "strong",
              },
            ],
            { signal },
          );
          if (
            !messages.some(
              (event) => event.id === id && event.pubkey === session.viewer,
            )
          )
            throw new Error(
              "The saved message is unavailable and its local recovery is missing. Delivery stopped to avoid creating a duplicate thread.",
            );
        } else {
          const active = () => !signal.aborted;
          if (recovery) {
            if (!outbox.snapshot().some((item) => item.event.id === id))
              throw new Error(
                "Reload this page to recover the saved message from another window.",
              );
            if (
              recovery.delivery !== "accepted" &&
              recovery.delivery !== "seen" &&
              recovery.delivery !== "sending"
            )
              outbox.retry(recovery.event.id, active);
          } else {
            if (thread.started)
              throw new Error(
                "Delivery was started but its recovery journal is missing. Check the channel; no replacement thread was created.",
              );
            record = await write(
              session,
              channel,
              replaceDeliveryThread(record.value, index, {
                ...thread,
                request: thread.request ?? crypto.randomUUID(),
                started: true,
              }),
              record,
              signal,
            );
            onProgress(record);
            signal.throwIfAborted();
            try {
              id = outbox.send(
                threadMessage(
                  record.value,
                  channel,
                  index,
                  session.agentChoices
                    .snapshot()
                    .selectable.find(
                      (choice) =>
                        choice.pubkey ===
                        (record.value.triage?.state === "pending"
                          ? record.value.triage.agent
                          : submissionLane(record.value, index)?.reviewers[0]),
                    )?.name,
                  record.value.triage?.state === "pending"
                    ? admission?.documentation
                    : documentation,
                ),
                { key, value: artifactId },
                active,
              );
            } catch (reason) {
              // Admission can fail before enqueue (for example a full outbox).
              // Only this still-active invocation can prove nothing was queued.
              if (!signal.aborted && !(await outbox.recovery(key))) {
                record = await write(
                  session,
                  channel,
                  replaceDeliveryThread(
                    record.value,
                    index,
                    thread.request ? { request: thread.request } : {},
                  ),
                  record,
                  signal,
                );
                onProgress(record);
              }
              throw reason;
            }
          }
          const sentId = id;
          if (!sentId)
            throw new Error("Message delivery did not return an identity.");
          if (!thread.id) {
            record = await write(
              session,
              channel,
              replaceDeliveryThread(record.value, index, {
                ...deliveryThreads(record.value)[index],
                id: sentId,
              }),
              record,
              signal,
            );
            onProgress(record);
          }
          await delivered(outbox, sentId, signal);
        }
        const deliveredId = id;
        if (!deliveredId)
          throw new Error("Missing delivered message identity.");
        record = await write(
          session,
          channel,
          replaceDeliveryThread(record.value, index, {
            ...deliveryThreads(record.value)[index],
            id: deliveredId,
            delivered: true,
          }),
          record,
          signal,
        );
        onProgress(record);
        await outbox.acknowledge(deliveredId);
      }
      return record;
    },
  );
}
