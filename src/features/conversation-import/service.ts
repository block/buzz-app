import { Service, type Context } from "@deepseek-ai/cordis";
import { getEventHash } from "nostr-tools";
import type {} from "../communities/service";
import { attachmentMarkdown, attachmentName } from "../relay/attachments";
import type { RelayEvent, ReadFilter } from "../relay/events";
import { claimImportWriter, type ImportWriter } from "../relay/import-writes";
import type { OutgoingEvent } from "../relay/outbox";
import { splitPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  VERIFIED_PROFILE_BATCH,
  VERIFIED_PROFILE_KIND,
  verifiedProfile as readVerifiedProfile,
  type VerifiedProfile,
} from "../relay/verified-profile";
import {
  completeTemplate,
  consentTemplate,
  fingerprint,
  IMPORT_PROPOSAL_KIND,
  IMPORT_SNAPSHOT_KIND,
  parseProposal,
  parseSnapshot,
  preparedProblem,
  proposalProblem,
  proposalTemplate,
  SOURCE_KIND_LABELS,
  sourceLabel,
  withdrawTemplate,
  type ParsedProposal,
  type ParsedSnapshot,
} from "./protocol";
import {
  isImportReviews,
  type ImportReview,
  type ImportReviews,
  type ReviewMember,
} from "./reviews";
import { relayMediaType, SNIFF_BYTES } from "./relay-media-type";
import type {
  AttachmentTagsInput,
  ConversationImportService,
  ImportCounts,
  ImportedAttachment,
  ImportProposalInput,
  ImportSessionView,
  ImportSourceKind,
  MembershipView,
  PreparedImportEvent,
  PublishProgress,
  PublishReport,
  ReadBackEvent,
  ReadBackReport,
  UnsignedImportEvent,
  VerifiedProfileView,
} from "./types";

const HEX64 = /^[0-9a-f]{64}$/;
/** At most 8 events per second, under the relay's 10 per second socket limit. */
const PACE_MS = 125;
const PARENT_POLL_MS = 5_000;
/** How long a missing parent may wait without any partner progress. */
const PARENT_STALL_MS = 10 * 60_000;
const RATE_LIMIT_WAIT_MS = 15_000;
/** Retry delay for a warming refusal when the snapshot gives no later time. */
const WARMING_RETRY_MS = 5_000;
/** The relay's refusal while a newly active session's replica catches up. */
const WARMING = /\bimport session warming\b/;
/** Above the outbox's own delivery timeout. */
const SETTLE_AFTER_STOP_MS = 30_000;
const READ_PAGE = 200;
const ROSTER_KIND = 39002;
const ROSTER_ATTEMPTS = 5;
const ROSTER_RETRY_MS = 1_000;

const NO_RELAY_SUPPORT =
  "This community's relay does not support conversation import.";
const DESTINATION_CHANGED =
  "The destination conversation changed while the dialog was open. Nothing was sent.";
const EXPECTED_MEMBERS_INVALID =
  "The expected members must match the import's participants.";
const MEMBERS_UNCONFIRMED =
  "The conversation's members could not be confirmed with the relay. Try again.";
const NOT_CONFIRMED = "The relay has not confirmed that this import is active.";

export type ConversationImportOptions = {
  /** Test seam for pacing and polling delays. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Current time in seconds. */
  now?: () => number;
  /** Current time in milliseconds, for pacing. */
  clock?: () => number;
};

type Entry = { proposal: ParsedProposal; snapshot?: ParsedSnapshot };
type HostState = {
  relay: RelayData;
  reviews: ImportReviews;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  clock: () => number;
  session?: RelaySession;
  stopLive?: () => void;
  loaded: boolean;
  entries: Map<string, Entry>;
  orphans: Map<string, ParsedSnapshot>;
  /** Each snapshot's `accepts_after` on this device's clock. */
  starts: WeakMap<ParsedSnapshot, number>;
  known: Map<string, Set<string>>;
  views: readonly ImportSessionView[];
  listeners: Set<(sessions: readonly ImportSessionView[]) => void>;
};

/** Plugins reach the service object, including through cordis's proxy, so
 * host state is keyed by an opaque token and resolved only in this module. */
const HOST: unique symbol = Symbol("conversationImport");
const hosts = new WeakMap<object, HostState>();
/** Only `createConversationImportHost` holds this, so a plugin reaching the
 * class through `constructor` cannot build a host of its own. */
const MINT: unique symbol = Symbol("conversationImportMint");

function stateOf(host: ConversationImportHost): HostState {
  const state = hosts.get(host[HOST]);
  if (!state) throw new Error("Conversation import is unavailable");
  return state;
}

const defaultWait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

const declined = () =>
  new DOMException("The request was not approved", "AbortError");

function verifiedView(
  pubkey: string,
  verified: VerifiedProfile,
): VerifiedProfileView {
  return Object.freeze({
    pubkey,
    displayName: verified.displayName,
    username: verified.username,
    ...(verified.fullName !== undefined ? { fullName: verified.fullName } : {}),
    issuerLabel: verified.issuerLabel,
    verifiedAt: verified.verifiedAt,
    fingerprint: fingerprint(pubkey),
  });
}

function sessionView(
  entry: Entry,
  now: number,
  acceptsAfter?: number,
): ImportSessionView {
  const { proposal, snapshot } = entry;
  const expired = !snapshot && proposal.content.expires_at <= now;
  return Object.freeze({
    proposalId: proposal.id,
    channelId: proposal.channelId,
    proposer: proposal.proposer,
    proposedAt: proposal.createdAt,
    proposal: proposal.content,
    status: snapshot?.status ?? (expired ? "expired" : "proposed"),
    required:
      snapshot?.required ??
      Object.freeze(proposal.content.participants.map((item) => item.pubkey)),
    consents: snapshot?.consents ?? Object.freeze({}),
    published: snapshot?.published ?? Object.freeze({}),
    completed: snapshot?.completed ?? Object.freeze([]),
    expires_at: snapshot?.expires_at ?? proposal.content.expires_at,
    ...(acceptsAfter !== undefined ? { acceptsAfter } : {}),
    confirmed: !!snapshot,
  });
}

const startOf = (state: HostState, entry: Entry) =>
  entry.snapshot && state.starts.get(entry.snapshot);

const viewOf = (state: HostState, entry: Entry) =>
  sessionView(entry, state.now(), startOf(state, entry));

/** Publishing needs the relay's own word that the session is active. */
function inactiveReason(entry: Entry, now: number, viewer: string) {
  if (!entry.snapshot) return NOT_CONFIRMED;
  const status = sessionView(entry, now).status;
  if (status !== "active") return `This import is ${status}.`;
  if (entry.snapshot.completed.includes(viewer))
    return "You already completed this import.";
}

function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDuration(events: number) {
  const seconds = Math.ceil((events * PACE_MS) / 1000);
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60
    ? `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
    : `about ${Math.ceil(minutes / 60)} hours`;
}

function formatList(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const totalCounts = (proposal: ParsedProposal["content"]) =>
  proposal.participants.reduce(
    (sum, item) => ({
      messages: sum.messages + item.messages,
      reactions: sum.reactions + item.reactions,
    }),
    { messages: 0, reactions: 0 },
  );

const sameSet = (members: readonly string[], expected: ReadonlySet<string>) =>
  new Set(members).size === expected.size &&
  members.every((key) => expected.has(key));

function sameView(a: MembershipView, b: MembershipView) {
  return (
    a.channelType === b.channelType &&
    a.visibility === b.visibility &&
    sameSet(a.members, new Set(b.members))
  );
}

/** Whether the destination's type and visibility can hold this source. */
function shapeMatches(kind: ImportSourceKind, view: MembershipView) {
  if (kind === "dm" || kind === "group_dm") return view.channelType === "dm";
  return (
    view.channelType === "channel" &&
    view.visibility === (kind === "private_channel" ? "private" : "public")
  );
}

/** Direct messages must name exactly the participants; private channels at
 * most the participants. Public channels may pin any member set. */
function expectedMembersProblem(
  kind: ImportSourceKind,
  participants: ReadonlySet<string>,
  expected: readonly string[] | undefined,
) {
  if (!expected) return;
  if (
    !Array.isArray(expected) ||
    new Set(expected).size !== expected.length ||
    expected.some((key) => typeof key !== "string" || !HEX64.test(key))
  )
    return EXPECTED_MEMBERS_INVALID;
  if (
    (kind === "dm" || kind === "group_dm") &&
    !sameSet(expected, participants)
  )
    return EXPECTED_MEMBERS_INVALID;
  if (
    kind === "private_channel" &&
    expected.some((key) => !participants.has(key))
  )
    return EXPECTED_MEMBERS_INVALID;
}

/** Waits for the journal to settle one delivery attempt. With `vanish`, an
 * entry that is no longer in the journal settles as undefined. */
function settled(
  writer: ImportWriter,
  id: string,
  signal?: AbortSignal,
  vanish = false,
): Promise<OutgoingEvent | undefined> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const finish = (item: OutgoingEvent | undefined) => {
      stop();
      signal?.removeEventListener("abort", abort);
      resolve(item);
    };
    const abort = () => {
      stop();
      reject(signal?.reason);
    };
    const check = () => {
      const item = writer.local
        .snapshot()
        .find((entry) => entry.event.id === id);
      if (!item) {
        if (vanish) finish(undefined);
        return;
      }
      if (item.delivery !== "sending") finish(item);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    stop = writer.local.subscribe(check);
    check();
  });
}

/** `settled` for an attempt the caller no longer waits on. A closed journal
 * never settles, so this gives up after `ms` and dismisses the entry, which
 * then can neither publish later nor go uncounted. */
async function settledWithin(
  state: HostState,
  writer: ImportWriter,
  id: string,
  ms: number,
) {
  const stop = new AbortController();
  let expired = false;
  try {
    const item = await Promise.race([
      settled(writer, id, stop.signal, true),
      state.wait(ms, stop.signal).then(
        () => {
          expired = true;
        },
        () => {},
      ),
    ]);
    if (!expired) return item || undefined;
    void writer.dismiss(id).catch(() => {});
    return undefined;
  } finally {
    stop.abort();
  }
}

const failure = (item: OutgoingEvent | undefined) =>
  item?.reason ?? item?.error ?? "Delivery could not be confirmed";

const deliveredOk = (item: OutgoingEvent | undefined) =>
  item?.delivery === "accepted" || item?.delivery === "seen";

/** Host service for consented conversation import (NIP-CI). Plugins get read
 * models and request writes; every consent-bearing write goes through a
 * host-owned dialog, and the host signs. */
export class ConversationImportHost
  extends Service
  implements ConversationImportService
{
  declare readonly [HOST]: object;
  constructor(
    ctx: Context,
    relay: RelayData,
    reviews: ImportReviews,
    options: ConversationImportOptions,
    mint: typeof MINT,
  ) {
    if (mint !== MINT || !isImportReviews(reviews))
      throw new Error("Conversation import is provided by the host.");
    super(ctx, "conversationImport");
    const state: HostState = {
      relay,
      reviews,
      wait: options.wait ?? defaultWait,
      now: options.now ?? (() => Math.floor(Date.now() / 1000)),
      clock: options.clock ?? Date.now,
      loaded: false,
      entries: new Map(),
      orphans: new Map(),
      starts: new WeakMap(),
      known: new Map(),
      views: Object.freeze([]),
      listeners: new Set(),
    };
    const key = Object.freeze({});
    Object.defineProperty(this, HOST, { value: key });
    hosts.set(key, state);
    const sync = () => bind(state);
    sync();
    const stop = relay.subscribe(sync);
    ctx.effect(() => () => {
      stop();
      state.stopLive?.();
      state.listeners.clear();
    });
  }

  verifiedProfile(pubkey: string): VerifiedProfileView | undefined {
    const session = stateOf(this).session;
    if (!session || !HEX64.test(pubkey)) return;
    const profile = session.profiles.snapshot().get(pubkey);
    if (!profile) void session.profiles.ensure([pubkey]).catch(() => {});
    return profile?.verified && verifiedView(pubkey, profile.verified);
  }

  async findVerified(
    query: { email?: string; username?: string },
    signal?: AbortSignal,
  ): Promise<VerifiedProfileView[]> {
    const session = current(stateOf(this));
    const username = query.username?.trim().toLowerCase();
    if (!username)
      throw new Error(
        "Verified profiles carry no email address. Search by username instead.",
      );
    if (!/^[a-z0-9._-]{1,64}$/.test(username))
      throw new Error("That is not a valid username.");
    const active = signal ?? new AbortController().signal;
    const candidates = new Set<string>();
    for (const [pubkey, profile] of session.profiles.snapshot())
      if (profile.verified?.username === username) candidates.add(pubkey);
    for (const event of await session.searchProfiles(username, {
      limit: 100,
      signal: active,
    }))
      candidates.add(event.pubkey);
    const verified = await readVerified(session, [...candidates], active);
    return [...verified.values()].filter(
      (profile) => profile.username === username,
    );
  }

  membership(channelId: string): MembershipView | undefined {
    return membershipOf(stateOf(this), channelId);
  }

  async ensureDirectMessage(
    otherPubkeys: string[],
    opts: { createIfMissing: boolean },
    signal?: AbortSignal,
  ) {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const others = [...new Set(otherPubkeys)];
    if (
      !others.length ||
      others.length > 8 ||
      others.length !== otherPubkeys.length ||
      others.some((key) => !HEX64.test(key) || key === viewer)
    )
      throw new Error("Choose between one and eight other people.");
    const expected = new Set([viewer, ...others]);
    const existing = session.channels
      .list()
      .channels.find(
        (channel) =>
          channel.channelType === "dm" &&
          !channel.archived &&
          channel.members?.length === expected.size &&
          channel.members.every((key) => expected.has(key)),
      );
    if (existing) {
      const members = await readMembers(state, session, existing.id, signal);
      if (!sameSet(members, expected)) throw new Error(MEMBERS_UNCONFIRMED);
      return { channelId: existing.id, created: false, members };
    }
    if (!opts.createIfMissing)
      throw new Error("No direct message with exactly these people exists.");
    const verified = await readVerified(session, others, signal);
    const missing = others.filter((key) => !verified.has(key));
    const approved = await state.reviews.request(
      {
        type: "direct-message",
        title: "Start a direct message for the import?",
        description:
          "Buzz will open a direct message with exactly these people so their shared history can be imported into it.",
        facts: [{ label: "Members", value: String(expected.size) }],
        members: [viewer, ...others].map((pubkey) =>
          member(pubkey, verified.get(pubkey) ?? selfVerified(session, pubkey)),
        ),
        ...(missing.length
          ? {
              refusal: `${missing.length === 1 ? "One person has" : `${missing.length} people have`} no verified Buzz identity.`,
            }
          : {}),
        confirmLabel: "Start direct message",
      },
      signal,
    );
    if (!approved) throw declined();
    const channelId = await session.directMessages.open(
      others,
      signal ?? new AbortController().signal,
    );
    const members = await readMembers(
      state,
      session,
      channelId,
      signal,
      (found) => sameSet(found, expected),
    );
    if (!sameSet(members, expected)) throw new Error(MEMBERS_UNCONFIRMED);
    return { channelId, created: true, members };
  }

  async ensureChannel(
    input: {
      name: string;
      visibility: "private" | "public";
      members: string[];
      existingChannelId?: string;
    },
    signal?: AbortSignal,
  ) {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const requested = [...new Set([viewer, ...input.members])];
    if (
      requested.some((key) => !HEX64.test(key)) ||
      (input.visibility !== "private" && input.visibility !== "public")
    )
      throw new Error("The channel members or visibility are invalid.");
    const visibilityText =
      input.visibility === "private" ? "private" : "public";
    if (input.existingChannelId) {
      const channelId = input.existingChannelId;
      const channel = session.channels
        .list()
        .channels.find((item) => item.id === channelId);
      if (channel?.channelType !== "stream")
        throw new Error("That channel is unavailable.");
      if (channel.archived) throw new Error("That channel is archived.");
      const view = membershipOf(state, channelId);
      if (view?.visibility !== input.visibility)
        throw new Error(`That channel is not ${visibilityText}.`);
      const members = await readMembers(state, session, channelId, signal);
      if (!members.includes(viewer))
        throw new Error("You are not a member of that channel.");
      const outsiders = members.filter((key) => !requested.includes(key));
      if (input.visibility === "private" && outsiders.length)
        throw new Error(
          `${outsiders.length === 1 ? "One member" : `${outsiders.length} members`} of that channel ${outsiders.length === 1 ? "is" : "are"} not in the source conversation.`,
        );
      return { channelId, created: false, members };
    }
    const name = input.name.trim();
    if (!name) throw new Error("The channel needs a name.");
    const verified = await readVerified(session, requested, signal);
    const missing = requested.filter(
      (key) => key !== viewer && !verified.has(key),
    );
    const approved = await state.reviews.request(
      {
        type: "channel",
        title: `Create #${name} for the import?`,
        description:
          input.visibility === "private"
            ? "Buzz will create a private channel with exactly these members."
            : "Buzz will create a public channel and add these members.",
        facts: [
          {
            label: "Visibility",
            value: input.visibility === "private" ? "Private" : "Public",
          },
          { label: "Members", value: String(requested.length) },
        ],
        members: requested.map((pubkey) =>
          member(pubkey, verified.get(pubkey) ?? selfVerified(session, pubkey)),
        ),
        ...(missing.length
          ? {
              refusal: `${missing.length === 1 ? "One member has" : `${missing.length} members have`} no verified Buzz identity.`,
            }
          : {}),
        confirmLabel: "Create channel",
      },
      signal,
    );
    if (!approved) throw declined();
    const channelId = await session.channelCreation.create({
      name,
      visibility: input.visibility === "public" ? "open" : "private",
    });
    for (const pubkey of requested)
      if (pubkey !== viewer)
        await session.memberAdditions.add(channelId, pubkey);
    const expected = new Set(requested);
    const members = await readMembers(
      state,
      session,
      channelId,
      signal,
      (found) =>
        input.visibility === "private"
          ? sameSet(found, expected)
          : requested.every((key) => found.includes(key)),
    );
    if (input.visibility === "private" && !sameSet(members, expected))
      throw new Error(MEMBERS_UNCONFIRMED);
    return { channelId, created: true, members };
  }

  async propose(input: ImportProposalInput, signal?: AbortSignal) {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const writer = writerOf(state, session);
    if (!session.conversationImport) throw new Error(NO_RELAY_SUPPORT);
    const { channelId, ...content } = input;
    const problem = proposalProblem(content, state.now());
    if (problem) throw new Error(problem);
    const channel = session.channels
      .list()
      .channels.find((item) => item.id === channelId);
    const view = membershipOf(state, channelId);
    if (!channel || !view?.members.includes(viewer))
      throw new Error("You are not a member of that conversation.");
    const pubkeys = content.participants.map((item) => item.pubkey);
    const verified = await readVerified(session, pubkeys, signal);
    const refusal = destinationRefusal(content, view, pubkeys, verified);
    const totals = totalCounts(content);
    const approved = await state.reviews.request(
      {
        type: "propose",
        title: `Import ${content.source.label} from ${sourceLabel(content.source.type)}?`,
        description:
          "Each participant must accept before anything is imported. Each person then publishes their own messages at their original times.",
        facts: [
          {
            label: "Destination",
            value: destinationText(session, channel.name, view, verified),
          },
          { label: "Source", value: SOURCE_KIND_LABELS[content.source.kind] },
          {
            label: "Date range",
            value: `${formatDate(content.range.from)} to ${formatDate(content.range.to)}`,
          },
          {
            label: "Messages",
            value: `${totals.messages} messages, ${totals.reactions} reactions`,
          },
          ...excludedFact(content),
          {
            label: "Estimated time",
            value: formatDuration(totals.messages + totals.reactions),
          },
          { label: "Manifest", value: fingerprint(content.manifest) },
        ],
        members: content.participants.map((item) =>
          member(
            item.pubkey,
            verified.get(item.pubkey),
            `${item.messages} messages, ${item.reactions} reactions`,
          ),
        ),
        ...(refusal ? { refusal } : {}),
        confirmLabel: "Propose import",
      },
      signal,
    );
    if (!approved) throw declined();
    const after = membershipOf(state, channelId);
    if (
      !after ||
      !sameView(view, after) ||
      destinationRefusal(content, after, pubkeys, verified)
    )
      throw new Error(DESTINATION_CHANGED);
    const id = writer.sendRecord(proposalTemplate(input));
    await delivered(writer, id, signal);
    const event = writer.local
      .snapshot()
      .find((item) => item.event.id === id)?.event;
    if (event) ingest(state, [event as RelayEvent]);
    return { proposalId: id };
  }

  async consent(
    proposalId: string,
    decision: "accept" | "decline",
    sourceUserHash: string,
    signal?: AbortSignal,
  ) {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const writer = writerOf(state, session);
    if (!session.conversationImport) throw new Error(NO_RELAY_SUPPORT);
    if (decision !== "accept" && decision !== "decline")
      throw new Error("Choose accept or decline.");
    const entry = await entryFor(state, proposalId, signal);
    const { content, channelId } = entry.proposal;
    const participant = content.participants.find(
      (item) => item.pubkey === viewer,
    );
    const channel = session.channels
      .list()
      .channels.find((item) => item.id === channelId);
    const admin =
      sourceUserHash === "admin" &&
      ["owner", "admin"].includes(channel?.viewerRole ?? "");
    if (!participant && !admin)
      throw new Error("You are not a participant in this import.");
    if (participant && !admin && participant.source_user !== sourceUserHash)
      throw new Error(
        "That source identity does not match your entry in the proposal.",
      );
    const status = viewOf(state, entry).status;
    if (status !== "proposed" && status !== "active")
      throw new Error(`This import is ${status}.`);
    const pubkeys = content.participants.map((item) => item.pubkey);
    const view = membershipOf(state, channelId);
    const verified = await readVerified(session, pubkeys, signal);
    const refusal =
      decision === "accept"
        ? view
          ? destinationRefusal(content, view, pubkeys, verified)
          : "The destination conversation is unavailable."
        : undefined;
    const totals = totalCounts(content);
    const approved = await state.reviews.request(
      {
        type: "consent",
        title:
          decision === "accept"
            ? `Accept importing ${content.source.label} from ${sourceLabel(content.source.type)}?`
            : `Decline importing ${content.source.label}?`,
        description:
          decision === "accept"
            ? "Check that the manifest fingerprint matches the one shown to the proposer before accepting."
            : "Declining ends this import for the conversation.",
        facts: [
          ...(view
            ? [
                {
                  label: "Destination",
                  value: destinationText(
                    session,
                    channel?.name ?? "",
                    view,
                    verified,
                  ),
                },
              ]
            : []),
          { label: "Source", value: SOURCE_KIND_LABELS[content.source.kind] },
          {
            label: "Date range",
            value: `${formatDate(content.range.from)} to ${formatDate(content.range.to)}`,
          },
          {
            label: "Messages",
            value: `${totals.messages} messages, ${totals.reactions} reactions`,
          },
          ...(participant
            ? [
                {
                  label: "Yours",
                  value: `${participant.messages} messages, ${participant.reactions} reactions`,
                },
              ]
            : []),
          ...excludedFact(content),
          {
            label: "Estimated time",
            value: formatDuration(totals.messages + totals.reactions),
          },
          { label: "Manifest", value: fingerprint(content.manifest) },
        ],
        members: content.participants.map((item) =>
          member(
            item.pubkey,
            verified.get(item.pubkey),
            `${item.messages} messages, ${item.reactions} reactions`,
          ),
        ),
        ...(decision === "accept" && participant
          ? {
              statement:
                "Your own messages from this source will be published by you, at their original times.",
            }
          : {}),
        ...(refusal ? { refusal } : {}),
        confirmLabel:
          decision === "accept" ? "Accept import" : "Decline import",
        ...(decision === "decline" ? { destructive: true } : {}),
      },
      signal,
    );
    if (!approved) throw declined();
    if (decision === "accept") {
      const after = membershipOf(state, channelId);
      if (
        !view ||
        !after ||
        !sameView(view, after) ||
        destinationRefusal(content, after, pubkeys, verified)
      )
        throw new Error(DESTINATION_CHANGED);
    }
    const id = writer.sendRecord(
      consentTemplate(
        {
          id: proposalId,
          channelId,
          manifest: content.manifest,
          proposer: entry.proposal.proposer,
        },
        decision,
        admin ? "admin" : sourceUserHash,
      ),
    );
    await delivered(writer, id, signal);
    void refreshSnapshot(state, entry, signal).catch(() => {});
  }

  async withdraw(proposalId: string, reason?: string) {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const writer = writerOf(state, session);
    const entry = await entryFor(state, proposalId);
    const { proposal } = entry;
    if (
      proposal.proposer !== viewer &&
      !proposal.content.participants.some((item) => item.pubkey === viewer)
    )
      throw new Error("Only the proposer or a participant can withdraw.");
    const id = writer.sendRecord(
      withdrawTemplate(proposalId, proposal.channelId, reason),
    );
    await delivered(writer, id);
    void refreshSnapshot(state, entry).catch(() => {});
  }

  async complete(proposalId: string, published: ImportCounts) {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const writer = writerOf(state, session);
    const entry = await entryFor(state, proposalId);
    if (
      !entry.proposal.content.participants.some(
        (item) => item.pubkey === viewer,
      )
    )
      throw new Error("You are not a participant in this import.");
    const id = writer.sendRecord(
      completeTemplate(proposalId, entry.proposal.channelId, published),
    );
    await delivered(writer, id);
    void refreshSnapshot(state, entry).catch(() => {});
  }

  session(proposalId: string): ImportSessionView | undefined {
    return stateOf(this).views.find((view) => view.proposalId === proposalId);
  }

  async refresh(
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<ImportSessionView | undefined> {
    const state = stateOf(this);
    const known = state.entries.get(proposalId);
    const entry = known ?? (await entryFor(state, proposalId, signal));
    if (known) await refreshSnapshot(state, entry, signal);
    return viewOf(state, entry);
  }

  subscribe(cb: (sessions: readonly ImportSessionView[]) => void) {
    const state = stateOf(this);
    state.listeners.add(cb);
    cb(state.views);
    return () => {
      state.listeners.delete(cb);
    };
  }

  eventId(unsigned: UnsignedImportEvent): string {
    return eventIdOf(unsigned);
  }

  exists(channelId: string, eventId: string): boolean {
    return existsIn(stateOf(this), channelId, eventId);
  }

  async publish(
    proposalId: string,
    events: readonly PreparedImportEvent[],
    opts: {
      onProgress?: (p: PublishProgress) => void;
      expectedMembers?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<PublishReport> {
    const state = stateOf(this);
    const session = current(state);
    const viewer = viewerOf(session);
    const writer = writerOf(state, session);
    const entry = await entryFor(state, proposalId, signal);
    const { proposal } = entry;
    const channelId = proposal.channelId;
    const ids: string[] = [];
    const report = (
      status: PublishReport["status"],
      stoppedAt?: number,
      reason?: string,
    ): PublishReport =>
      Object.freeze({
        status,
        published: ids.length,
        ids: Object.freeze([...ids]),
        ...(stoppedAt !== undefined ? { stoppedAt } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    const participants = new Set(
      proposal.content.participants.map((item) => item.pubkey),
    );
    if (!participants.has(viewer))
      return report("rejected", 0, "You are not a participant in this import.");
    const kind = proposal.content.source.kind;
    const invalid = expectedMembersProblem(
      kind,
      participants,
      opts.expectedMembers,
    );
    if (invalid) return report("rejected", 0, invalid);
    const expected = events.map((event) =>
      eventIdOf({ ...event, pubkey: viewer }),
    );
    const own = new Map(expected.map((id, index) => [id, index]));
    const rules = {
      proposalId,
      channelId,
      sourceType: proposal.content.source.type,
      range: proposal.content.range,
    };
    for (const [index, event] of events.entries()) {
      const problem = preparedProblem(event, rules, state.now());
      if (problem) return report("rejected", index, problem);
      for (const reference of references(event)) {
        const at = own.get(reference);
        if (at !== undefined && at >= index)
          return report(
            "rejected",
            index,
            "An event is listed before the event it refers to.",
          );
      }
    }
    // Direct messages and private channels hold exactly the source's people;
    // anyone added later must not receive the rest of the history.
    const exact = opts.expectedMembers
      ? new Set(opts.expectedMembers)
      : kind === "public_channel"
        ? undefined
        : participants;
    const destinationProblem = (view: MembershipView | undefined) => {
      if (!view?.members.includes(viewer))
        return "You are no longer a member of the destination conversation.";
      if (!shapeMatches(kind, view))
        return "The destination's type or visibility changed. Nothing more was imported.";
      if (exact && !sameSet(view.members, exact))
        return "The destination's members changed. Nothing more was imported.";
    };
    const before = destinationProblem(membershipOf(state, channelId));
    if (before) return report("stopped", 0, before);
    await refreshSnapshot(state, entry, signal).catch(() => {});
    const total = events.length;
    let lastSend = 0;
    let pending: string | undefined;
    const starting = async (ms: number) => {
      opts.onProgress?.({ phase: "starting", published: ids.length, total });
      await state.wait(ms, signal);
    };
    try {
      const inactive = total && inactiveReason(entry, state.now(), viewer);
      if (inactive) return report("stopped", 0, inactive);
      const ready = startOf(state, entry);
      if (total && ready !== undefined && ready > state.now())
        await starting((ready - state.now()) * 1000);
      for (let index = 0; index < total; ) {
        const event = events[index] as PreparedImportEvent;
        signal?.throwIfAborted();
        const stopped = inactiveReason(entry, state.now(), viewer);
        if (stopped) return report("stopped", index, stopped);
        for (const reference of references(event)) {
          if (own.has(reference) || existsIn(state, channelId, reference))
            continue;
          const waited = await waitForEvent(
            state,
            session,
            entry,
            channelId,
            reference,
            (waitingFor) =>
              opts.onProgress?.({
                published: ids.length,
                total,
                waitingFor,
              }),
            signal,
          );
          if (waited !== true) return report("waiting", index, waited);
        }
        const gap = state.clock() - lastSend;
        if (index && gap < PACE_MS) await state.wait(PACE_MS - gap, signal);
        // Checked after every wait, immediately before signing.
        const changed = destinationProblem(membershipOf(state, channelId));
        if (changed) return report("stopped", index, changed);
        lastSend = state.clock();
        const id = expected[index] as string;
        pending = id;
        const result = await sendImported(state, writer, event, signal);
        pending = undefined;
        if (result !== id && result && WARMING.test(result)) {
          // Nothing was stored, so the same event goes again once warm.
          await refreshSnapshot(state, entry, signal).catch(() => {});
          const until = startOf(state, entry);
          const ms = until === undefined ? 0 : (until - state.now()) * 1000;
          await starting(ms > 0 ? ms : WARMING_RETRY_MS);
          continue;
        }
        if (result !== id)
          return report("rejected", index, result ?? "Delivery failed");
        ids.push(id);
        rememberIds(state, channelId, [id]);
        opts.onProgress?.({ published: ids.length, total });
        index++;
      }
    } catch (error) {
      if (pending) {
        // An event already handed to the relay may still land; the report
        // counts it only if it did, and a refusal leaves no journal entry.
        const item = await settledWithin(
          state,
          writer,
          pending,
          SETTLE_AFTER_STOP_MS,
        );
        if (deliveredOk(item)) {
          ids.push(pending);
          rememberIds(state, channelId, [pending]);
        } else if (item) void writer.dismiss(pending).catch(() => {});
      }
      if (signal?.aborted) return report("stopped", ids.length, "Stopped");
      return report(
        "rejected",
        ids.length,
        error instanceof Error ? error.message : String(error),
      );
    }
    return report("done");
  }

  attachmentTags(input: AttachmentTagsInput): ImportedAttachment {
    return predictAttachment(current(stateOf(this)), input).attachment;
  }

  async uploadAttachment(
    file: Blob,
    name: string,
    sha256Hex: string,
    signal?: AbortSignal,
    options?: { channelId?: string },
  ): Promise<ImportedAttachment> {
    const session = current(stateOf(this));
    const active = signal ?? new AbortController().signal;
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    active.throwIfAborted();
    const predicted = predictAttachment(session, {
      sha256Hex,
      name,
      size: file.size,
      head,
    });
    const attachments = session.attachments;
    if (!attachments)
      throw new Error("Uploads are unavailable on this connection.");
    const type = file.type || predicted.mime;
    const upload = new File([file], attachmentName(name), { type });
    const result = options?.channelId
      ? await attachments.upload(upload, options.channelId, active)
      : attachments.uploadForNewChat
        ? await attachments.uploadForNewChat(upload, active)
        : undefined;
    if (!result)
      throw new Error("Choose the destination conversation before uploading.");
    if (
      result.sha256 !== sha256Hex ||
      result.url !== predicted.url ||
      result.type !== predicted.mime ||
      result.size !== file.size
    )
      throw new Error(
        "The server stored this file differently than other participants will expect, so it cannot be attached. Import it without the file instead.",
      );
    return predicted.attachment;
  }

  async readBack(
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<ReadBackReport> {
    const state = stateOf(this);
    const session = current(state);
    const entry = await entryFor(state, proposalId, signal);
    const { proposal } = entry;
    const events = await readAll(
      session,
      {
        kinds: [9, 7],
        "#h": [proposal.channelId],
        authors: proposal.content.participants.map((item) => item.pubkey),
        since: proposal.content.range.from,
        until: proposal.content.range.to + 1,
        limit: READ_PAGE,
      },
      signal,
    );
    const imported: ReadBackEvent[] = [];
    for (const event of events) {
      if (
        !event.tags.some((tag) => tag[0] === "import" && tag[1] === proposalId)
      )
        continue;
      const source = event.tags.find((tag) => tag[0] === "source");
      imported.push(
        Object.freeze({
          id: event.id,
          pubkey: event.pubkey,
          kind: event.kind,
          source_ref: source?.[2] ?? "",
          created_at: event.created_at,
        }),
      );
    }
    rememberIds(
      state,
      proposal.channelId,
      imported.map((item) => item.id),
    );
    return Object.freeze({
      events: Object.freeze(
        imported.sort(
          (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
        ),
      ),
    });
  }
}

/** The host's conversation import service; `reviews` must come from
 * `createImportReviews`. */
export function createConversationImportHost(
  ctx: Context,
  relay: RelayData,
  reviews: ImportReviews,
  options: ConversationImportOptions = {},
) {
  return new ConversationImportHost(ctx, relay, reviews, options, MINT);
}

function current(state: HostState): RelaySession {
  const session = state.relay.snapshot().session;
  if (state.session !== session) bind(state);
  return session;
}

function viewerOf(session: RelaySession) {
  const viewer = session.viewer;
  if (!viewer) throw new Error("Sign in to import conversations.");
  return viewer;
}

function writerOf(state: HostState, session: RelaySession) {
  const writer = claimImportWriter(session, state);
  if (!writer)
    throw new Error("This connection cannot publish conversation imports.");
  return writer;
}

function membershipOf(
  state: HostState,
  channelId: string,
): MembershipView | undefined {
  const channel = state.session?.channels
    .list()
    .channels.find((item) => item.id === channelId);
  if (!channel?.members) return;
  return Object.freeze({
    members: [...channel.members],
    channelType: channel.channelType === "dm" ? "dm" : "channel",
    visibility: channel.visibility ?? (channel.private ? "private" : "unknown"),
  });
}

function eventIdOf(unsigned: UnsignedImportEvent) {
  if (!HEX64.test(unsigned.pubkey))
    throw new Error("The event author must be a 64-character hex key.");
  return getEventHash({
    pubkey: unsigned.pubkey,
    created_at: unsigned.created_at,
    kind: unsigned.kind,
    tags: unsigned.tags.map((tag) => [...tag]),
    content: unsigned.content,
  });
}

function existsIn(state: HostState, channelId: string, eventId: string) {
  if (state.known.get(channelId)?.has(eventId)) return true;
  const session = state.session;
  const writer = session && claimImportWriter(session, state);
  return !!writer?.local
    .snapshot()
    .some(
      (item) =>
        item.event.id === eventId &&
        deliveredOk(item) &&
        item.event.tags.some(([name, id]) => name === "h" && id === channelId),
    );
}

function member(
  pubkey: string,
  verified: VerifiedProfileView | undefined,
  note?: string,
): ReviewMember {
  return Object.freeze({
    pubkey,
    ...(verified ? { verified } : {}),
    ...(note ? { note } : {}),
  });
}

function selfVerified(session: RelaySession, pubkey: string) {
  const verified = session.profiles.snapshot().get(pubkey)?.verified;
  return verified && verifiedView(pubkey, verified);
}

function displayName(
  session: RelaySession,
  verified: ReadonlyMap<string, VerifiedProfileView>,
  pubkey: string,
) {
  const profile = session.profiles.snapshot().get(pubkey);
  return (
    verified.get(pubkey)?.displayName ??
    profile?.verified?.displayName ??
    profile?.name ??
    fingerprint(pubkey).slice(0, 8)
  );
}

function destinationText(
  session: RelaySession,
  name: string,
  view: MembershipView,
  verified: ReadonlyMap<string, VerifiedProfileView>,
) {
  if (view.channelType === "dm")
    return `Direct message with ${formatList(
      view.members
        .filter((key) => key !== session.viewer)
        .map((key) => displayName(session, verified, key)),
    )}`;
  const type =
    view.visibility === "private"
      ? "private channel"
      : view.visibility === "public"
        ? "public channel"
        : "channel";
  return `#${name} (${type})`;
}

function excludedFact(content: ParsedProposal["content"]) {
  return content.excluded_authors
    ? [
        {
          label: "Not imported",
          value: `Messages from ${content.excluded_authors} ${content.excluded_authors === 1 ? "person" : "people"} without a verified Buzz identity`,
        },
      ]
    : [];
}

/** Destination refusals: the human gate offers no approval for these. */
function destinationRefusal(
  content: ParsedProposal["content"],
  view: MembershipView,
  pubkeys: readonly string[],
  verified: ReadonlyMap<string, VerifiedProfileView>,
): string | undefined {
  const unverified = pubkeys.filter((key) => !verified.has(key));
  if (unverified.length)
    return `${unverified.length === 1 ? "One participant has" : `${unverified.length} participants have`} no verified Buzz identity.`;
  const outside = pubkeys.filter((key) => !view.members.includes(key));
  if (outside.length)
    return `${outside.length === 1 ? "One participant is" : `${outside.length} participants are`} not a member of the destination.`;
  const direct =
    content.source.kind === "dm" || content.source.kind === "group_dm";
  if (direct !== (view.channelType === "dm"))
    return direct
      ? "A direct message can only be imported into a direct message."
      : "A channel can only be imported into a channel.";
  if (
    direct &&
    (view.members.length !== pubkeys.length ||
      view.members.some((key) => !pubkeys.includes(key)))
  )
    return "The direct message members differ from the source conversation's.";
  if (content.source.kind === "private_channel") {
    if (view.visibility !== "private")
      return "A private channel can only be imported into a private channel.";
    const extra = view.members.filter((key) => !pubkeys.includes(key));
    if (extra.length)
      return `${extra.length === 1 ? "One member" : `${extra.length} members`} of the destination ${extra.length === 1 ? "is" : "are"} not in the source channel.`;
  }
  if (content.source.kind === "public_channel" && view.visibility !== "public")
    return "A public channel can only be imported into a public channel.";
}

/** The URL the relay assigns a file: `/media/<sha256>.<ext>` on the
 * community origin, with the type and extension the relay sniffs from the
 * file's first bytes. */
function predictAttachment(session: RelaySession, input: AttachmentTagsInput) {
  const { sha256Hex, name, size } = input;
  if (typeof sha256Hex !== "string" || !HEX64.test(sha256Hex))
    throw new Error("The file hash must be 64 lowercase hex characters.");
  if (typeof name !== "string") throw new Error("The file needs a name.");
  const { mime, ext } = relayMediaType(input.head, size);
  const origin = splitPartition(session.scope)?.communityOrigin;
  let base: URL | undefined;
  try {
    base = origin ? new URL(origin) : undefined;
  } catch {
    base = undefined;
  }
  if (!base || (base.protocol !== "https:" && base.protocol !== "http:"))
    throw new Error("Uploads are unavailable on this connection.");
  const url = new URL(`/media/${sha256Hex}.${ext}`, base).href;
  const label = attachmentName(name);
  const attachment: ImportedAttachment = Object.freeze({
    url,
    tags: [
      [
        "imeta",
        `url ${url}`,
        `m ${mime}`,
        `size ${size}`,
        `x ${sha256Hex}`,
        `filename ${label}`,
      ],
    ],
    markdown: attachmentMarkdown(label, { url, type: mime }),
  });
  return { attachment, mime, url };
}

/** The relay-signed member list (kind 39002) for a conversation. `settle`
 * retries a short while for a roster that has not caught up yet. */
async function readMembers(
  state: HostState,
  session: RelaySession,
  channelId: string,
  signal?: AbortSignal,
  settle?: (members: readonly string[]) => boolean,
): Promise<string[]> {
  const read = session.snapshotRead;
  const authority = session.relayAuthor;
  if (!read || !authority) throw new Error(MEMBERS_UNCONFIRMED);
  let members: string[] | undefined;
  for (let attempt = 0; attempt < (settle ? ROSTER_ATTEMPTS : 1); attempt++) {
    if (attempt) await state.wait(ROSTER_RETRY_MS, signal);
    const events = await read(
      [
        {
          kinds: [ROSTER_KIND],
          authors: [authority],
          "#d": [channelId],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    const roster = events
      .filter(
        (event) =>
          event.kind === ROSTER_KIND &&
          event.pubkey === authority &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === channelId),
      )
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!roster) continue;
    members = [
      ...new Set(
        roster.tags
          .filter((tag) => tag[0] === "p" && HEX64.test(tag[1] ?? ""))
          .map((tag) => tag[1] as string),
      ),
    ];
    if (!settle || settle(members)) break;
  }
  if (!members) throw new Error(MEMBERS_UNCONFIRMED);
  return members;
}

async function readVerified(
  session: RelaySession,
  pubkeys: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, VerifiedProfileView>> {
  const result = new Map<string, VerifiedProfileView>();
  const unique = [...new Set(pubkeys)].filter((key) => HEX64.test(key));
  const authority = session.relayAuthor;
  if (!unique.length) return result;
  if (!session.snapshotRead || !authority) {
    for (const pubkey of unique) {
      const view = selfVerified(session, pubkey);
      if (view) result.set(pubkey, view);
    }
    return result;
  }
  for (let start = 0; start < unique.length; start += VERIFIED_PROFILE_BATCH) {
    const batch = unique.slice(start, start + VERIFIED_PROFILE_BATCH);
    const events = await session.snapshotRead(
      [
        {
          kinds: [VERIFIED_PROFILE_KIND],
          authors: [authority],
          "#d": batch,
          limit: batch.length,
        },
      ],
      { signal },
    );
    const newest = new Map<string, RelayEvent>();
    for (const event of events) {
      const subject = event.tags.find((tag) => tag[0] === "d")?.[1];
      if (!subject || !batch.includes(subject)) continue;
      const prior = newest.get(subject);
      if (!prior || event.created_at > prior.created_at)
        newest.set(subject, event);
    }
    for (const [subject, event] of newest) {
      const verified = readVerifiedProfile(
        event,
        { pubkey: authority, multipleIssuers: false },
        true,
      );
      if (verified) result.set(subject, verifiedView(subject, verified));
    }
  }
  return result;
}

/** Every page of a filter, newest first, by the relay's composite cursor. */
async function readAll(
  session: RelaySession,
  filter: ReadFilter,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  const read = session.snapshotRead;
  if (!read) throw new Error("This connection cannot read import history.");
  const seen = new Map<string, RelayEvent>();
  let cursor: { until: number; before_id: string } | undefined;
  for (;;) {
    const page = await read([{ ...filter, ...(cursor ?? {}) }], { signal });
    let added = 0;
    for (const event of page)
      if (!seen.has(event.id)) {
        seen.set(event.id, event);
        added++;
      }
    const oldest = [...page].sort(
      (a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id),
    )[0];
    if (page.length < filter.limit || !added || !oldest) break;
    cursor = { until: oldest.created_at, before_id: oldest.id };
  }
  return [...seen.values()];
}

function references(event: PreparedImportEvent) {
  return event.tags
    .filter((tag) => tag[0] === "e" && HEX64.test(tag[1] ?? ""))
    .map((tag) => tag[1] as string);
}

function rememberIds(
  state: HostState,
  channelId: string,
  ids: readonly string[],
) {
  let known = state.known.get(channelId);
  if (!known) {
    known = new Set();
    state.known.set(channelId, known);
  }
  for (const id of ids) known.add(id);
}

async function delivered(
  writer: ImportWriter,
  id: string,
  signal?: AbortSignal,
) {
  const item = await settled(writer, id, signal);
  if (deliveredOk(item)) return;
  void writer.dismiss(id).catch(() => {});
  throw new Error(failure(item));
}

/** Publishes one prepared event at its original time. Returns its id, or the
 * relay's refusal text verbatim. A rate limit waits and retries; any other
 * outcome is final for this run and leaves no journal entry behind. */
async function sendImported(
  state: HostState,
  writer: ImportWriter,
  event: PreparedImportEvent,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const id = writer.sendAt(event);
  const existing = writer.local.snapshot().find((item) => item.event.id === id);
  if (existing?.delivery === "failed" || existing?.delivery === "unknown")
    writer.retry(id);
  for (;;) {
    const item = await settled(writer, id, signal);
    if (deliveredOk(item)) return id;
    const reason = failure(item);
    if (item?.delivery === "failed" && /rate-limited:/.test(reason)) {
      await state.wait(RATE_LIMIT_WAIT_MS, signal);
      writer.retry(id);
      continue;
    }
    void writer.dismiss(id).catch(() => {});
    return reason;
  }
}

/** NIP-CI parent wait: poll for another participant's parent every 5 seconds
 * while their published counters move; give up after 10 minutes without
 * progress. */
async function waitForEvent(
  state: HostState,
  session: RelaySession,
  entry: Entry,
  channelId: string,
  id: string,
  progress: (waitingFor: string) => void,
  signal?: AbortSignal,
): Promise<true | string> {
  const viewer = session.viewer;
  const others = entry.proposal.content.participants.filter(
    (item) =>
      item.pubkey !== viewer &&
      !entry.snapshot?.completed.includes(item.pubkey),
  );
  const names = others.map((item) =>
    displayName(session, new Map(), item.pubkey),
  );
  const waitingFor =
    names.length === 1 ? (names[0] ?? "") : "other participants";
  const counted = () =>
    others.reduce((sum, item) => {
      const counts = entry.snapshot?.published[item.pubkey];
      return sum + (counts ? counts.messages + counts.reactions : 0);
    }, 0);
  let last = counted();
  let lastProgress = state.clock();
  for (;;) {
    progress(waitingFor);
    const found = session.snapshotRead
      ? await session.snapshotRead(
          [{ ids: [id], "#h": [channelId], limit: 1 }],
          { signal },
        )
      : [];
    if (found.some((event) => event.id === id)) {
      rememberIds(state, channelId, [id]);
      return true;
    }
    if (state.known.get(channelId)?.has(id)) return true;
    await refreshSnapshot(state, entry, signal).catch(() => {});
    const stopped = inactiveReason(entry, state.now(), "");
    if (stopped) return stopped;
    const now = counted();
    if (now > last) {
      last = now;
      lastProgress = state.clock();
    }
    if (state.clock() - lastProgress >= PARENT_STALL_MS)
      return `waiting for ${waitingFor} to import`;
    await state.wait(PARENT_POLL_MS, signal);
  }
}

async function entryFor(
  state: HostState,
  proposalId: string,
  signal?: AbortSignal,
): Promise<Entry> {
  if (!HEX64.test(proposalId)) throw new Error("Unknown import proposal.");
  const known = state.entries.get(proposalId);
  if (known) return known;
  const session = current(state);
  const events = session.snapshotRead
    ? await session.snapshotRead(
        [{ ids: [proposalId], kinds: [IMPORT_PROPOSAL_KIND], limit: 1 }],
        { signal },
      )
    : [];
  ingest(state, events);
  const entry = state.entries.get(proposalId);
  if (!entry) throw new Error("Unknown import proposal.");
  await refreshSnapshot(state, entry, signal).catch(() => {});
  return entry;
}

async function refreshSnapshot(
  state: HostState,
  entry: Entry,
  signal?: AbortSignal,
) {
  const session = state.session;
  if (!session?.snapshotRead || !session.relayAuthor) return;
  const events = await session.snapshotRead(
    [
      {
        kinds: [IMPORT_SNAPSHOT_KIND],
        authors: [session.relayAuthor],
        "#d": [entry.proposal.id],
        limit: 1,
      },
    ],
    { signal },
  );
  ingest(state, events);
}

function ingest(state: HostState, events: readonly RelayEvent[]) {
  const session = state.session;
  let changed = false;
  for (const event of events) {
    if (event.kind === IMPORT_PROPOSAL_KIND) {
      if (state.entries.has(event.id)) continue;
      const proposal = parseProposal(event);
      if (!proposal) continue;
      const entry: Entry = { proposal };
      const orphan = state.orphans.get(event.id);
      if (orphan?.channelId === proposal.channelId) entry.snapshot = orphan;
      state.orphans.delete(event.id);
      state.entries.set(event.id, entry);
      changed = true;
    } else if (event.kind === IMPORT_SNAPSHOT_KIND) {
      const snapshot = parseSnapshot(event, session?.relayAuthor);
      if (!snapshot) continue;
      // A snapshot stamped ahead of this device shows the relay's clock runs
      // ahead by at least that much. A relay clock running behind cannot be
      // seen here; its warming refusal covers that case.
      if (snapshot.accepts_after !== undefined)
        state.starts.set(
          snapshot,
          snapshot.accepts_after -
            Math.max(0, snapshot.createdAt - state.now()),
        );
      const entry = state.entries.get(snapshot.proposalId);
      if (!entry) {
        const prior = state.orphans.get(snapshot.proposalId);
        if (!prior || snapshot.createdAt >= prior.createdAt)
          state.orphans.set(snapshot.proposalId, snapshot);
        continue;
      }
      if (
        entry.proposal.channelId === snapshot.channelId &&
        (!entry.snapshot || snapshot.createdAt >= entry.snapshot.createdAt)
      ) {
        entry.snapshot = snapshot;
        changed = true;
      }
    } else if (event.kind === 9 || event.kind === 7) {
      const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
      if (channelId) rememberIds(state, channelId, [event.id]);
    }
  }
  if (changed) publishViews(state);
}

function publishViews(state: HostState) {
  const now = state.now();
  state.views = Object.freeze(
    [...state.entries.values()]
      .map((entry) => sessionView(entry, now, startOf(state, entry)))
      .sort(
        (a, b) =>
          b.proposedAt - a.proposedAt ||
          a.proposalId.localeCompare(b.proposalId),
      ),
  );
  for (const listener of [...state.listeners]) {
    try {
      listener(state.views);
    } catch (error) {
      console.error("Conversation import listener failed", error);
    }
  }
}

/** Follows the relay session: a new session starts a new read model. */
function bind(state: HostState) {
  const snapshot = state.relay.snapshot();
  const session = snapshot.session;
  if (state.session !== session) {
    claimImportWriter(session, state);
    state.stopLive?.();
    state.session = session;
    state.loaded = false;
    state.entries.clear();
    state.orphans.clear();
    state.known.clear();
    state.stopLive = session.subscribeLive((batch) =>
      ingest(state, batch.events),
    );
    publishViews(state);
  }
  if (!state.loaded && snapshot.status === "ready" && session.viewer) {
    state.loaded = true;
    void load(state, session).catch(() => {
      if (state.session === session) state.loaded = false;
    });
  }
}

async function load(state: HostState, session: RelaySession) {
  const viewer = session.viewer;
  if (!viewer || !session.snapshotRead) return;
  const filters: ReadFilter[] = [
    { kinds: [IMPORT_PROPOSAL_KIND], "#p": [viewer], limit: READ_PAGE },
    { kinds: [IMPORT_PROPOSAL_KIND], authors: [viewer], limit: READ_PAGE },
    ...(session.relayAuthor
      ? [
          {
            kinds: [IMPORT_SNAPSHOT_KIND],
            authors: [session.relayAuthor],
            "#p": [viewer],
            limit: READ_PAGE,
          },
        ]
      : []),
  ];
  for (const filter of filters) {
    const events = await readAll(session, filter);
    if (state.session !== session) return;
    ingest(state, events);
  }
}

export type { ImportReview };
