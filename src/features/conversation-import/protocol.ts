import type {
  ImportCounts,
  ImportProposalInput,
  ImportSourceKind,
  ImportStatus,
  PreparedImportEvent,
  ProposalParticipant,
} from "./types";

/** NIP-CI conversation import kinds. */
export const IMPORT_PROPOSAL_KIND = 42110;
export const IMPORT_CONSENT_KIND = 42111;
export const IMPORT_WITHDRAW_KIND = 42112;
export const IMPORT_COMPLETE_KIND = 42113;
export const IMPORT_SNAPSHOT_KIND = 30623;
export const IMPORT_RECORD_KINDS: readonly number[] = [
  IMPORT_PROPOSAL_KIND,
  IMPORT_CONSENT_KIND,
  IMPORT_WITHDRAW_KIND,
  IMPORT_COMPLETE_KIND,
];
export const MAX_PROPOSAL_CONTENT_BYTES = 16 * 1024;
export const MAX_PARTICIPANTS = 64;

const HEX64 = /^[0-9a-f]{64}$/;
const SOURCE_TYPE = /^[a-z0-9_-]{1,32}$/;
const SOURCE_KINDS: readonly ImportSourceKind[] = [
  "dm",
  "group_dm",
  "private_channel",
  "public_channel",
];
const STATUSES: readonly ImportStatus[] = [
  "proposed",
  "active",
  "declined",
  "withdrawn",
  "expired",
  "completed",
];

type Tags = readonly (readonly string[])[];
type Tagged = Readonly<{ kind: number; tags: Tags }>;
type Signed = Tagged &
  Readonly<{ id: string; pubkey: string; content: string; created_at: number }>;

const tagValue = (tags: Tags, name: string) =>
  tags.find((tag) => tag[0] === name)?.[1];
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const parse = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

/** Any kind 9 or 7 carrying an `import` tag is history: it never notifies,
 * marks unread or bumps a conversation. */
export function isImportedEvent(event: Tagged) {
  return (
    (event.kind === 9 || event.kind === 7) &&
    event.tags.some((tag) => tag[0] === "import")
  );
}

/** A live batch without imported history, for consumers that act on fresh
 * activity such as agent dispatch. Returns the same batch when none is. */
export function withoutImported<
  T extends Readonly<{ events: readonly Tagged[] }>,
>(batch: T): T {
  return batch.events.some(isImportedEvent)
    ? {
        ...batch,
        events: batch.events.filter((event) => !isImportedEvent(event)),
      }
    : batch;
}

export function sourceLabel(type: string) {
  return type
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

export const SOURCE_KIND_LABELS: Readonly<Record<ImportSourceKind, string>> = {
  dm: "Direct message",
  group_dm: "Group direct message",
  private_channel: "Private channel",
  public_channel: "Public channel",
};

/** A 64-character hex key or hash as 8 groups of 8. */
export function fingerprint(hex: string) {
  return (hex.match(/.{1,8}/g) ?? []).join(" ");
}

export type ImportedMarker = Readonly<{
  proposalId: string;
  source: string;
  ref: string;
  sourceEdited?: true;
}>;

export function importedMarker(event: Tagged): ImportedMarker | undefined {
  if (event.kind !== 9) return;
  const imports = event.tags.filter((tag) => tag[0] === "import");
  const sources = event.tags.filter((tag) => tag[0] === "source");
  const proposalId = imports[0]?.[1];
  const source = sources[0]?.[1];
  const ref = sources[0]?.[2];
  if (
    imports.length !== 1 ||
    sources.length !== 1 ||
    !proposalId ||
    !HEX64.test(proposalId) ||
    !source ||
    !SOURCE_TYPE.test(source) ||
    !ref
  )
    return;
  return Object.freeze({
    proposalId,
    source,
    ref,
    ...(event.tags.some((tag) => tag[0] === "source-edited" && tag[1] === "1")
      ? { sourceEdited: true as const }
      : {}),
  });
}

export type ImportProposalContent = Omit<ImportProposalInput, "channelId">;

/** Strict 42110 content. Returns the first rule the input breaks. */
export function proposalProblem(
  input: ImportProposalContent,
  now: number,
): string | undefined {
  const { source, range, participants } = input;
  if (!record(source) || !SOURCE_TYPE.test(String(source.type)))
    return "The source type is invalid.";
  if (!HEX64.test(String(source.conversation)))
    return "The source conversation hash is invalid.";
  if (!SOURCE_KINDS.includes(source.kind))
    return "The source conversation kind is invalid.";
  if (
    typeof source.label !== "string" ||
    !source.label.trim() ||
    [...source.label].length > 80
  )
    return "The source label must be 1 to 80 characters.";
  if (
    !record(range) ||
    !count(range.from) ||
    !count(range.to) ||
    range.from >= range.to ||
    range.to > now
  )
    return "The date range must end in the past and after it starts.";
  if (
    !Array.isArray(participants) ||
    participants.length < 1 ||
    participants.length > MAX_PARTICIPANTS
  )
    return `An import needs 1 to ${MAX_PARTICIPANTS} participants.`;
  const seen = new Set<string>();
  for (const participant of participants) {
    if (
      !record(participant) ||
      !HEX64.test(String(participant.pubkey)) ||
      !HEX64.test(String(participant.source_user)) ||
      !count(participant.messages) ||
      !count(participant.reactions) ||
      seen.has(String(participant.pubkey))
    )
      return "A participant entry is invalid or repeated.";
    seen.add(String(participant.pubkey));
  }
  if (!count(input.excluded_authors))
    return "The excluded author count is invalid.";
  if (!HEX64.test(String(input.manifest)))
    return "The manifest hash is invalid.";
  if (!count(input.expires_at) || input.expires_at <= now)
    return "The proposal expiry must be in the future.";
}

const sortedParticipants = (participants: readonly ProposalParticipant[]) =>
  [...participants].sort((a, b) =>
    a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0,
  );

/** Kind 42110 with the NIP-CI key and tag order. */
export function proposalTemplate(input: ImportProposalInput) {
  const participants = sortedParticipants(input.participants);
  const content = JSON.stringify({
    v: 1,
    source: {
      type: input.source.type,
      conversation: input.source.conversation,
      kind: input.source.kind,
      label: input.source.label,
    },
    range: { from: input.range.from, to: input.range.to },
    participants: participants.map((participant) => ({
      pubkey: participant.pubkey,
      source_user: participant.source_user,
      messages: participant.messages,
      reactions: participant.reactions,
    })),
    excluded_authors: input.excluded_authors,
    manifest: input.manifest,
    expires_at: input.expires_at,
  });
  if (new TextEncoder().encode(content).length > MAX_PROPOSAL_CONTENT_BYTES)
    throw new Error("The import proposal is larger than 16 KiB.");
  return {
    kind: IMPORT_PROPOSAL_KIND,
    content,
    tags: [
      ["h", input.channelId],
      ...participants.map((participant) => ["p", participant.pubkey]),
      ["manifest", input.manifest],
      ["import-source", input.source.type],
    ],
  };
}

export function consentTemplate(
  proposal: Readonly<{
    id: string;
    channelId: string;
    manifest: string;
    proposer: string;
  }>,
  decision: "accept" | "decline",
  sourceUser: string,
) {
  return {
    kind: IMPORT_CONSENT_KIND,
    content: JSON.stringify({ v: 1, decision, source_user: sourceUser }),
    tags: [
      ["e", proposal.id],
      ["h", proposal.channelId],
      ["manifest", proposal.manifest],
      ["p", proposal.proposer],
    ],
  };
}

export function withdrawTemplate(
  proposalId: string,
  channelId: string,
  reason?: string,
) {
  const text = reason?.trim();
  if (text && [...text].length > 200)
    throw new Error("A withdrawal reason can be at most 200 characters.");
  return {
    kind: IMPORT_WITHDRAW_KIND,
    content: JSON.stringify(text ? { v: 1, reason: text } : { v: 1 }),
    tags: [
      ["e", proposalId],
      ["h", channelId],
    ],
  };
}

export function completeTemplate(
  proposalId: string,
  channelId: string,
  published: ImportCounts,
) {
  if (!count(published.messages) || !count(published.reactions))
    throw new Error("Published counts must be whole numbers.");
  return {
    kind: IMPORT_COMPLETE_KIND,
    content: JSON.stringify({
      v: 1,
      published: {
        messages: published.messages,
        reactions: published.reactions,
      },
    }),
    tags: [
      ["e", proposalId],
      ["h", channelId],
    ],
  };
}

export type ParsedProposal = Readonly<{
  id: string;
  channelId: string;
  proposer: string;
  createdAt: number;
  content: ImportProposalContent;
}>;

/** A 42110 whose tags agree with its content. Validity against the clock is
 * the relay's call; the read model only rejects malformed records. */
export function parseProposal(event: Signed): ParsedProposal | undefined {
  if (event.kind !== IMPORT_PROPOSAL_KIND) return;
  const channelId = tagValue(event.tags, "h");
  const body = parse(event.content);
  if (!channelId || !record(body) || body.v !== 1) return;
  const content = body as unknown as ImportProposalContent;
  if (
    !record(content.source) ||
    !record(content.range) ||
    !Array.isArray(content.participants) ||
    !count(content.expires_at) ||
    proposalProblem(
      { ...content, expires_at: Number.MAX_SAFE_INTEGER },
      Number(content.range.to),
    )
  )
    return;
  const pubkeys = event.tags
    .filter((tag) => tag[0] === "p")
    .map((tag) => tag[1]);
  const declared = sortedParticipants(content.participants).map(
    (participant) => participant.pubkey,
  );
  if (
    tagValue(event.tags, "manifest") !== content.manifest ||
    tagValue(event.tags, "import-source") !== content.source.type ||
    pubkeys.length !== declared.length ||
    pubkeys.some((pubkey, index) => pubkey !== declared[index])
  )
    return;
  return Object.freeze({
    id: event.id,
    channelId,
    proposer: event.pubkey,
    createdAt: event.created_at,
    content: Object.freeze({
      source: Object.freeze({
        type: content.source.type,
        conversation: content.source.conversation,
        kind: content.source.kind,
        label: content.source.label,
      }),
      range: Object.freeze({ from: content.range.from, to: content.range.to }),
      participants: Object.freeze(
        content.participants.map((participant) =>
          Object.freeze({
            pubkey: participant.pubkey,
            source_user: participant.source_user,
            messages: participant.messages,
            reactions: participant.reactions,
          }),
        ),
      ),
      excluded_authors: content.excluded_authors,
      manifest: content.manifest,
      expires_at: content.expires_at,
    }),
  });
}

/** A conversation import event shown in the timeline. */
export type ImportRecord =
  | Readonly<{ type: "proposal"; proposal: ParsedProposal }>
  | Readonly<{
      type: "consent";
      proposalId: string;
      decision: "accept" | "decline";
      admin: boolean;
    }>
  | Readonly<{ type: "withdraw"; proposalId: string; reason?: string }>
  | Readonly<{
      type: "complete";
      proposalId: string;
      published: ImportCounts;
    }>;

export function importRecord(event: Signed): ImportRecord | undefined {
  if (event.kind === IMPORT_PROPOSAL_KIND) {
    const proposal = parseProposal(event);
    return proposal && Object.freeze({ type: "proposal", proposal });
  }
  const proposalId = tagValue(event.tags, "e");
  const body = parse(event.content);
  if (!proposalId || !HEX64.test(proposalId) || !record(body) || body.v !== 1)
    return;
  if (event.kind === IMPORT_CONSENT_KIND) {
    if (body.decision !== "accept" && body.decision !== "decline") return;
    return Object.freeze({
      type: "consent",
      proposalId,
      decision: body.decision,
      admin: body.source_user === "admin",
    });
  }
  if (event.kind === IMPORT_WITHDRAW_KIND)
    return Object.freeze({
      type: "withdraw",
      proposalId,
      ...(typeof body.reason === "string" && body.reason.trim()
        ? { reason: Array.from(body.reason.trim()).slice(0, 200).join("") }
        : {}),
    });
  if (event.kind === IMPORT_COMPLETE_KIND) {
    const published = body.published;
    if (
      !record(published) ||
      !count(published.messages) ||
      !count(published.reactions)
    )
      return;
    return Object.freeze({
      type: "complete",
      proposalId,
      published: Object.freeze({
        messages: published.messages,
        reactions: published.reactions,
      }),
    });
  }
}

/** Plain text for previews, search and a missing renderer. Names are added by
 * the timeline, which resolves the author. */
export function importRecordText(record: ImportRecord) {
  switch (record.type) {
    case "proposal":
      return `Proposed importing ${record.proposal.content.source.label} from ${sourceLabel(record.proposal.content.source.type)}`;
    case "consent":
      return record.decision === "accept"
        ? record.admin
          ? "Approved the conversation import as an admin"
          : "Accepted the conversation import"
        : "Declined the conversation import";
    case "withdraw":
      return record.reason
        ? `Withdrew the conversation import: ${record.reason}`
        : "Withdrew the conversation import";
    case "complete":
      return `Finished importing ${record.published.messages} ${record.published.messages === 1 ? "message" : "messages"} and ${record.published.reactions} ${record.published.reactions === 1 ? "reaction" : "reactions"}`;
  }
}

export type ParsedSnapshot = Readonly<{
  proposalId: string;
  channelId: string;
  createdAt: number;
  status: ImportStatus;
  required: readonly string[];
  consents: Readonly<Record<string, "accept" | "decline">>;
  published: Readonly<Record<string, ImportCounts>>;
  completed: readonly string[];
  expires_at: number;
  /** Relay-clock Unix seconds before which the relay refuses imported events
   * while the session warms up. */
  accepts_after?: number;
}>;

/** Only the community's relay key may state session status. */
export function parseSnapshot(
  event: Signed,
  relayAuthor: string | undefined,
): ParsedSnapshot | undefined {
  if (
    event.kind !== IMPORT_SNAPSHOT_KIND ||
    !relayAuthor ||
    event.pubkey !== relayAuthor
  )
    return;
  const proposalId = tagValue(event.tags, "d");
  const channelId = tagValue(event.tags, "h");
  const body = parse(event.content);
  if (
    !proposalId ||
    !HEX64.test(proposalId) ||
    !channelId ||
    !record(body) ||
    body.v !== 1 ||
    !STATUSES.includes(body.status as ImportStatus) ||
    !Array.isArray(body.required) ||
    !body.required.every((key) => HEX64.test(String(key))) ||
    !record(body.consents) ||
    !record(body.published) ||
    !Array.isArray(body.completed) ||
    !body.completed.every((key) => HEX64.test(String(key))) ||
    !count(body.expires_at)
  )
    return;
  const consents: Record<string, "accept" | "decline"> = {};
  for (const [key, value] of Object.entries(body.consents)) {
    if (!HEX64.test(key) || (value !== "accept" && value !== "decline")) return;
    consents[key] = value;
  }
  const published: Record<string, ImportCounts> = {};
  for (const [key, value] of Object.entries(body.published)) {
    if (
      !HEX64.test(key) ||
      !record(value) ||
      !count(value.messages) ||
      !count(value.reactions)
    )
      return;
    published[key] = Object.freeze({
      messages: value.messages,
      reactions: value.reactions,
    });
  }
  // A malformed value is ignored: a warming refusal still says when to retry.
  const acceptsAfter = tagValue(event.tags, "accepts_after");
  const accepts_after =
    acceptsAfter && /^\d{1,15}$/.test(acceptsAfter)
      ? Number(acceptsAfter)
      : undefined;
  return Object.freeze({
    proposalId,
    channelId,
    createdAt: event.created_at,
    status: body.status as ImportStatus,
    required: Object.freeze(body.required.map(String)),
    consents: Object.freeze(consents),
    published: Object.freeze(published),
    completed: Object.freeze(body.completed.map(String)),
    expires_at: body.expires_at,
    ...(accepts_after !== undefined ? { accepts_after } : {}),
  });
}

/** The first rule a prepared event breaks, or undefined. Mirrors the relay's
 * import acceptance rules that the client can check, and the canonical tag
 * order every participant needs for identical ids. */
export function preparedProblem(
  event: PreparedImportEvent,
  session: Readonly<{
    proposalId: string;
    channelId: string;
    sourceType: string;
    range: Readonly<{ from: number; to: number }>;
  }>,
  now: number,
): string | undefined {
  if (!event || (event.kind !== 9 && event.kind !== 7))
    return "Only messages (kind 9) and reactions (kind 7) can be imported.";
  if (
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < session.range.from ||
    event.created_at > session.range.to
  )
    return "The event time is outside the proposal's date range.";
  if (event.created_at > now) return "The event time is in the future.";
  if (typeof event.content !== "string" || !event.content.trim())
    return "The event has no content.";
  const tags = event.tags;
  if (
    !Array.isArray(tags) ||
    tags.some(
      (tag) =>
        !Array.isArray(tag) ||
        !tag.length ||
        tag.some((value) => typeof value !== "string"),
    )
  )
    return "The event tags are malformed.";
  let index = 0;
  const at = (): readonly string[] | undefined => tags[index];
  const expect = (
    test: (tag: readonly string[]) => boolean,
    problem: string,
  ) => {
    const tag = at();
    if (!tag || !test(tag)) return problem;
    index++;
  };
  const h = expect(
    (tag) => tag.length === 2 && tag[0] === "h" && tag[1] === session.channelId,
    "The first tag must be the destination channel.",
  );
  if (h) return h;
  if (event.kind === 9) {
    const root = at();
    if (root?.[0] === "e" && root[3] === "root") {
      if (root.length !== 4 || !HEX64.test(root[1] ?? "") || root[2] !== "")
        return "The thread root tag is malformed.";
      index++;
      if (at()?.[3] !== "reply")
        return "A thread root tag must be followed by a reply tag.";
    }
    const reply = at();
    if (reply?.[0] === "e") {
      if (
        reply.length !== 4 ||
        !HEX64.test(reply[1] ?? "") ||
        reply[2] !== "" ||
        reply[3] !== "reply"
      )
        return "The reply tag is malformed.";
      index++;
    }
    let previous = "";
    while (at()?.[0] === "p") {
      const value = at()?.[1] ?? "";
      if (at()?.length !== 2 || !HEX64.test(value) || value <= previous)
        return "Mention tags must be unique and sorted ascending.";
      previous = value;
      index++;
    }
  } else {
    const target = expect(
      (tag) => tag.length === 2 && tag[0] === "e" && HEX64.test(tag[1] ?? ""),
      "A reaction needs its target message tag after the channel tag.",
    );
    if (target) return target;
  }
  const importTag = expect(
    (tag) =>
      tag.length === 2 && tag[0] === "import" && tag[1] === session.proposalId,
    "The import tag must name this proposal.",
  );
  if (importTag) return importTag;
  const source = expect(
    (tag) =>
      tag.length === 3 &&
      tag[0] === "source" &&
      tag[1] === session.sourceType &&
      !!tag[2],
    "The source tag must name the proposal's source and a message reference.",
  );
  if (source) return source;
  if (event.kind === 9) {
    if (at()?.[0] === "source-edited") {
      if (at()?.length !== 2 || at()?.[1] !== "1")
        return "The source-edited tag is malformed.";
      index++;
    }
    if (at()?.[0] === "source-flag") {
      if (at()?.length !== 2 || at()?.[1] !== "broadcast")
        return "Only the broadcast source flag is defined.";
      index++;
    }
    while (at()?.[0] === "imeta") {
      if (
        !at()
          ?.slice(1)
          .some((field) => field.startsWith("url "))
      )
        return "An attachment tag has no URL.";
      index++;
    }
  }
  if (index !== tags.length)
    return `Unexpected tag "${tags[index]?.[0]}" at position ${index + 1}.`;
}
