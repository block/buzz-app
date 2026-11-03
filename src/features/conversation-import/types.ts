import type {} from "@deepseek-ai/cordis";
/** Plugin-facing conversation import types (NIP-CI). Exported through the
 * author package; the host service implements `ConversationImportService`. */

export type ImportSourceKind =
  | "dm"
  | "group_dm"
  | "private_channel"
  | "public_channel";

/** A relay-signed kind 30382 identity. Never derived from kind 0. */
export type VerifiedProfileView = Readonly<{
  pubkey: string;
  displayName: string;
  username: string;
  fullName?: string;
  issuerLabel: string;
  verifiedAt: number;
  /** The pubkey as 8 groups of 8 hex characters. */
  fingerprint: string;
}>;

export type ProposalParticipant = Readonly<{
  pubkey: string;
  source_user: string;
  messages: number;
  reactions: number;
}>;

/** Kind 42110 content plus the channel it is proposed in. The host adds the tags. */
export type ImportProposalInput = Readonly<{
  channelId: string;
  source: Readonly<{
    type: string;
    conversation: string;
    kind: ImportSourceKind;
    label: string;
  }>;
  range: Readonly<{ from: number; to: number }>;
  participants: readonly ProposalParticipant[];
  excluded_authors: number;
  manifest: string;
  expires_at: number;
}>;

export type ImportStatus =
  | "proposed"
  | "active"
  | "declined"
  | "withdrawn"
  | "expired"
  | "completed";

export type ImportCounts = Readonly<{ messages: number; reactions: number }>;

/** The relay snapshot (kind 30623) joined with the proposal it describes.
 * Before the relay publishes a snapshot, status is `proposed` and `required`
 * lists the proposal's participants. */
export type ImportSessionView = Readonly<{
  proposalId: string;
  channelId: string;
  proposer: string;
  /** Unix seconds of the proposal event. */
  proposedAt: number;
  proposal: Omit<ImportProposalInput, "channelId">;
  status: ImportStatus;
  required: readonly string[];
  consents: Readonly<Record<string, "accept" | "decline">>;
  published: Readonly<Record<string, ImportCounts>>;
  completed: readonly string[];
  expires_at: number;
  /** False until a relay-signed snapshot for this proposal has been read. */
  confirmed: boolean;
}>;

export type PreparedImportEvent = Readonly<{
  kind: 9 | 7;
  created_at: number;
  tags: readonly (readonly string[])[];
  content: string;
}>;

export type UnsignedImportEvent = PreparedImportEvent &
  Readonly<{ pubkey: string }>;

export type PublishProgress = Readonly<{
  published: number;
  total: number;
  /** Display name of the participant whose parent event is awaited. */
  waitingFor?: string;
}>;

export type PublishReport = Readonly<{
  /** `waiting`: a parent from another participant did not arrive in time.
   * `stopped`: cancelled, or the session stopped being active.
   * `rejected`: the host or relay refused an event; `reason` is verbatim. */
  status: "done" | "stopped" | "waiting" | "rejected";
  published: number;
  /** Ids of accepted events, in input order. */
  ids: readonly string[];
  /** Index of the first event not published. */
  stoppedAt?: number;
  reason?: string;
}>;

export type ReadBackEvent = Readonly<{
  id: string;
  pubkey: string;
  kind: number;
  source_ref: string;
  created_at: number;
}>;

export type ReadBackReport = Readonly<{ events: readonly ReadBackEvent[] }>;

export type MembershipView = Readonly<{
  members: string[];
  channelType: "dm" | "channel";
  visibility: "private" | "public" | "unknown";
}>;

export type ImportedAttachment = Readonly<{
  url: string;
  /** Attachment tags (one `imeta`) to embed in the imported event. */
  tags: string[][];
  /** The Markdown link Buzz appends to message content for this file. */
  markdown: string;
}>;

/** What every participant knows about a source file before anyone uploads it. */
export type AttachmentTagsInput = Readonly<{
  sha256Hex: string;
  name: string;
  size: number;
  /** The file's first 4096 bytes, or the whole file when shorter. The relay
   * stores a file under the type it sniffs from these, not a declared type. */
  head: Uint8Array;
}>;

export interface ConversationImportService {
  /** Verified identity from the relay-signed kind 30382 record; undefined when none. Never falls back to kind 0. */
  verifiedProfile(pubkey: string): VerifiedProfileView | undefined;
  /** Search verified profiles by exact username. Kind 30382 carries no
   * email, so an email-only query rejects. Returns only relay-verified records. */
  findVerified(
    query: { email?: string; username?: string },
    signal?: AbortSignal,
  ): Promise<VerifiedProfileView[]>;
  /** Finds the DM with exactly these members (viewer + others) or, after a host-owned confirmation listing fingerprints, opens it. */
  ensureDirectMessage(
    otherPubkeys: string[],
    opts: { createIfMissing: boolean },
    signal?: AbortSignal,
  ): Promise<{ channelId: string; created: boolean; members: string[] }>;
  /** Finds or creates a channel with the given name/visibility/members behind a host-owned confirmation. Private channels get exactly `members`. */
  ensureChannel(
    input: {
      name: string;
      visibility: "private" | "public";
      members: string[];
      existingChannelId?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ channelId: string; created: boolean; members: string[] }>;
  /** Current members of a channel (kind 39002 read model) and channel type/visibility. */
  membership(channelId: string): MembershipView | undefined;
  /** Shows the host-owned proposal dialog (dry-run summary) and on approval signs and publishes kind 42110. */
  propose(
    input: ImportProposalInput,
    signal?: AbortSignal,
  ): Promise<{ proposalId: string }>;
  /** Shows the host-owned consent dialog and on approval publishes kind 42111. */
  consent(
    proposalId: string,
    decision: "accept" | "decline",
    sourceUserHash: string,
    signal?: AbortSignal,
  ): Promise<void>;
  withdraw(proposalId: string, reason?: string): Promise<void>;
  complete(proposalId: string, published: ImportCounts): Promise<void>;
  /** Read model of the relay snapshot (kind 30623) plus the proposal content. */
  session(proposalId: string): ImportSessionView | undefined;
  /** Reads the proposal and its newest relay snapshot from the relay, for
   * proposals outside the viewer's own sessions. */
  refresh(
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<ImportSessionView | undefined>;
  /** All sessions visible to the viewer. Calls back immediately with the current list. */
  subscribe(cb: (sessions: readonly ImportSessionView[]) => void): () => void;
  /** Signs and publishes prepared events authored by the viewer under an active session. Validates each (pubkey = viewer, import tag = proposalId, kind 9|7, created_at within range, tag order), paces (<= 8 events/s), waits for cross-author parents, stops on the first rejection and returns the report.
   * Publishing requires a relay snapshot with status `active`. Immediately
   * before signing each event, the destination's type and visibility must
   * still match the source and its current members must equal
   * `expectedMembers` exactly. For direct message and private channel sources
   * it defaults to the proposal's participants; for direct messages it must
   * equal them, and for private channels it must be a subset of them. A
   * change stops the run with status `stopped`. */
  publish(
    proposalId: string,
    events: readonly PreparedImportEvent[],
    opts: {
      onProgress?: (p: PublishProgress) => void;
      expectedMembers?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<PublishReport>;
  /** The content-addressed URL, attachment tags and Markdown link for a file,
   * computed from its hash, name, size and first bytes alone, so every
   * participant derives the same event id whoever uploads it. Throws for a
   * file type the relay refuses or that cannot be predicted; import that
   * file as a placeholder instead. */
  attachmentTags(input: AttachmentTagsInput): ImportedAttachment;
  /** Uploads a file through the host media path and returns `attachmentTags`
   * for it. Throws when the server stores different bytes or a different URL
   * than predicted. Uploads are channel-scoped: pass the destination channel. */
  uploadAttachment(
    file: Blob,
    name: string,
    sha256Hex: string,
    signal?: AbortSignal,
    options?: { channelId?: string },
  ): Promise<ImportedAttachment>;
  /** Computes the Nostr id for an unsigned event (pubkey, created_at, kind, tags, content) so plugins can derive parent ids for other authors. */
  eventId(unsigned: UnsignedImportEvent): string;
  /** Checks whether an event id exists in the channel history read model (used while waiting for a partner's parent). */
  exists(channelId: string, eventId: string): boolean;
  /** Reads back imported events for a session: ids, authors, source refs, created_at. No content. */
  readBack(proposalId: string, signal?: AbortSignal): Promise<ReadBackReport>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    conversationImport: ConversationImportService;
  }
}
