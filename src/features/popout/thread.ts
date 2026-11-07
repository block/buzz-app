import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import {
  type CompanionAction,
  type CompanionManagement,
  type CompanionRow,
  projectCompanionRow,
} from "../companion/row";
import type {
  ContributionReader,
  MessageAction,
} from "../conversation/contracts";
import type { MainOperation } from "../companion/operations";
import { lastEditableMessage } from "../messages/useMessageEdit";
import { createAgentOwnerEvidence } from "../profiles/agent-owner-evidence";
import { knownAgentsOf } from "../messages/TypingIndicator";
import { currentActivity } from "../agents/current-activity";
import { formatPublicKey } from "../../shared/identity/public-key";
import { linkedAuthors } from "../conversation/linked-message";
import { messageLinkParts } from "../messages/message-link-parts";
import {
  isLiteralMarkdownContext,
  prepareMarkdown,
  type LiteralRange,
} from "../messages/markdown-preparation";
import { scanMarkdown } from "../relay/message-content";
import { parseBuzzLink } from "../navigation/buzz-links";

const bytes = (value: string) => new TextEncoder().encode(value).length;

/** What a pop-out window shows for one thread. Bounded like the native DTO. */
export type PopoutThreadView = {
  title: string;
  /** The owner's persistence scope, for message links the companion copies. */
  scope: string;
  status: "loading" | "ready" | "error";
  error?: string | undefined;
  writable: boolean;
  canLoadMore: boolean;
  limited: boolean;
  loadingOlder: boolean;
  /** Reading bridge token: main publishes reading intent for this window. */
  reading?: string | undefined;
  /** Main's durable read-intent revision when this view was produced. A
   * companion lease request carries the revision its event saw; main grants
   * it only while that is still current, so a manual unread in main cannot
   * be undone by reading intent formed before it. */
  readingRevision: number;
  composer?: string | undefined;
  version: number;
  root?: CompanionRow | undefined;
  replies: CompanionRow[];
  /** Main's outbox operations in this channel (reactions, removals, edits,
   * sent-to-channel copies), every delivery state, so a companion mirrors
   * real delivery and retries the admitted event even after its row is gone. */
  operations: MainOperation[];
  /** The viewer follows this thread. */
  following: boolean;
  /** A DM or Solo chat: no `#`, no thread following. */
  isDm: boolean;
  /** This frame shows a thread (root + replies), not a conversation timeline. */
  thread: boolean;
  /** People typing and agents working in this frame's conversation. */
  typing?: CompanionTyping | undefined;
};
export type { MainOperation };
const MAX_OPERATIONS = 64;
const MAX_REPLIES = 500;
/** Thread frames show messages only; a conversation timeline also shows
 * membership activity rows, as main's does. Huddle rows are never shown. */
const visible = (rows: readonly ChannelMessage[], timeline = false) =>
  rows.filter((row) => (timeline || !row.membership) && !row.huddle);
/** Who is typing or working here, as main's indicator would say it. */
export type CompanionTyping = {
  /** Up to two names; `more` counts the rest. */
  humans: string[];
  more: number;
  agents: string[];
};

/** What a frame reads: one thread (`session.thread`) or a conversation's
 * top-level timeline (`session.channels.window`). Loading, access and delivery
 * stay with the session; the projection only reads. */
type Source = {
  subscribe(listener: () => void): () => void;
  snapshot(): {
    status: "idle" | "loading" | "ready" | "error";
    error: string | undefined;
    root: ChannelMessage | undefined;
    rows: readonly ChannelMessage[];
    canLoadMore: boolean;
    limited: boolean;
    loadingOlder: boolean;
  };
  refresh(): void;
  older(): void;
  dispose(): void;
};
function threadSource(view: ThreadView): Source {
  return {
    subscribe: (listener) => view.subscribe(listener),
    snapshot() {
      const snap = view.snapshot();
      return {
        status: snap.status,
        error: snap.error,
        root: snap.root,
        rows: snap.replies,
        canLoadMore: snap.canLoadMore && !snap.limited,
        limited: snap.limited,
        loadingOlder: snap.readKind === "older",
      };
    },
    refresh: () => void view.refresh().catch(() => {}),
    older: () => void view.loadMore().catch(() => {}),
    dispose: () => view.dispose(),
  };
}
function channelSource(session: RelaySession, channelId: string): Source {
  session.channels.ensure(channelId);
  return {
    subscribe: (listener) =>
      session.channels.subscribeWindow(channelId, listener),
    snapshot() {
      const window = session.channels.window(channelId);
      return {
        status:
          window.status === "error"
            ? "error"
            : window.status === "ready"
              ? "ready"
              : "loading",
        error: window.error,
        root: undefined,
        rows: window.rows,
        canLoadMore: window.hasMore && !window.historyLimited,
        limited: !!window.historyLimited,
        loadingOlder: window.loadingOlder,
      };
    },
    refresh: () => {
      session.channels.ensure(channelId);
      session.channels.refresh?.(channelId);
    },
    older: () => session.channels.loadOlder(channelId),
    dispose: () => {},
  };
}

/** One session-owned reader for a pop-out frame: a thread when `rootId` is
 * given, else the conversation's timeline. Verified-root loading, access and
 * delivery stay with the session; this only projects. */
export function createPopoutThread(
  session: RelaySession,
  channelId: string,
  rootId: string | undefined,
  changed: () => void,
  /** Registered plugin message actions, offered as main-window handoffs.
   * The pop-out's own spawn action is never offered to a thread window. */
  actions?: ContributionReader<MessageAction>,
  excludedActions: ReadonlySet<string> = new Set(["open-thread-window"]),
) {
  let disposed = false;
  let version = 0;
  let error: string | undefined;
  const notify = () => {
    if (!disposed) {
      version++;
      changed();
    }
  };
  // Operations main admitted for this window: always projected, whatever
  // their delivery, until main has reported them delivered once; the only
  // ids this window may retry. Absence from a bounded list proves nothing.
  const admitted = new Map<
    string,
    { messageId: string | undefined; kind: MainOperation["kind"] }
  >();
  const MAX_ADMITTED = 256;
  // Owner evidence for agent authors among shown rows: the same store the
  // main menu renders, bounded; a message of an agent the viewer owns may be
  // deleted here once that evidence is ready.
  const evidence = new Map<
    string,
    ReturnType<typeof createAgentOwnerEvidence>
  >();
  const MAX_EVIDENCE = 32;
  // Authors of messages the shown rows link to, read through the same shared
  // lookups main's links use, so a bare `buzz://message` link labels
  // "<author> in #<channel>" here as it does there. Bounded; a link that
  // leaves the projection releases its lookup first.
  const linkAuthors = linkedAuthors(session);
  const linksWanted = new Map<string, () => void>();
  const MAX_LINKS = 64;
  const profilesEnsured = new Set<string>();
  let profilesEpoch = "";
  let thread: Source | undefined;
  try {
    thread = rootId
      ? threadSource(session.thread(channelId, rootId))
      : channelSource(session, channelId);
    // A session thread may contain seeded rows while still idle. Start its
    // verified read before subscribing: refresh publishes loading synchronously,
    // while the caller is still constructing this window's owner.
    thread.refresh();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : rootId
          ? "Couldn’t open this thread."
          : "Couldn’t open this conversation.";
  }
  const stops = [
    thread?.subscribe(notify),
    session.outbox?.subscribe(notify),
    session.channels.subscribeList(notify),
    session.profiles.subscribe(notify),
    session.unread.subscribe({ kind: "channel", channelId }, notify),
    rootId
      ? session.unread.subscribe({ kind: "thread", channelId, rootId }, notify)
      : undefined,
    session.unread.subscribeSync(notify),
    actions?.subscribe(notify),
    session.typing.subscribe(notify),
    session.agentActivity.subscribe(notify),
    session.agentChoices.subscribe(notify),
    linkAuthors.subscribe(notify),
    session.names?.subscribe(notify),
  ];
  type MessageLinkRef = { url: string; channelId: string; messageId: string };
  /** Literal contexts the renderer never links in: code, HTML, images,
   * definitions. Links themselves are considered by their label. */
  function codeRanges(content: string): LiteralRange[] {
    const ranges: LiteralRange[] = [];
    const pending = [scanMarkdown(content).tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (
        isLiteralMarkdownContext(node.type) &&
        node.type !== "link" &&
        node.type !== "linkReference"
      ) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          ranges.push({ start, end });
        continue;
      }
      pending.push(...(node.children ?? []));
    }
    return ranges;
  }
  /** Message links a row's rendered body shows as links, as `MessageMarkdown`
   * decides: none for a body it shows as plain text; none inside code, HTML,
   * images or definitions; a bare URL, `<url>` or `[url](url)` is looked up
   * (the renderer treats a label equal to its URL as none); any other label
   * stays the label. Keyed by the URL the renderer hands its link. */
  function messageLinks(content: string): MessageLinkRef[] {
    const prepared = prepareMarkdown(content);
    if (prepared.kind === "plain") return [];
    const literals = codeRanges(prepared.content);
    const links: MessageLinkRef[] = [];
    const consider = (start: number, end: number, url: string) => {
      if (literals.some((range) => start < range.end && end > range.start))
        return;
      const parsed = parseBuzzLink(url);
      if (parsed?.format === "legacy" && parsed.messageId)
        links.push({
          url,
          channelId: parsed.channelId,
          messageId: parsed.messageId,
        });
    };
    messageLinkParts(
      prepared.content,
      (start, end, label, url) => {
        if (label === url) consider(start, end, url);
      },
      (start, end, url) => {
        // Labelled links report through both callbacks; only bare ones here.
        if (!prepared.content.startsWith("[", start)) consider(start, end, url);
      },
    );
    return links;
  }
  // Rows keep their text between snapshots; parse each body once while shown.
  let linkCache = new Map<string, MessageLinkRef[]>();
  const linksOf = (row: ChannelMessage) => {
    let links = linkCache.get(row.content);
    if (!links) {
      links = messageLinks(row.content);
      linkCache.set(row.content, links);
    }
    return links;
  };
  /** Hold lookups for the links shown now, within the bound; links that left
   * the projection release theirs first. Profile requests for linked authors
   * follow the directory's invalidation contract: made again after a cache
   * clear (`generation`) or eviction (`evictions`), and only for authors of
   * links shown now. */
  function observeLinks(rows: readonly ChannelMessage[]) {
    if (disposed) return;
    const previous = linkCache;
    linkCache = new Map();
    const shown = new Map<string, MessageLinkRef>();
    for (const row of rows) {
      const links = previous.get(row.content) ?? messageLinks(row.content);
      linkCache.set(row.content, links);
      for (const link of links)
        shown.set(`${link.channelId}:${link.messageId}`, link);
    }
    for (const [key, release] of linksWanted)
      if (!shown.has(key)) {
        release();
        linksWanted.delete(key);
      }
    for (const [key, link] of shown) {
      if (linksWanted.has(key) || linksWanted.size >= MAX_LINKS) continue;
      // A link to a channel the byline never names needs no read.
      if (!linkedChannel(link.channelId)) continue;
      linksWanted.set(key, linkAuthors.want(link.channelId, link.messageId));
    }
    const epoch = `${session.profiles.generation?.() ?? 0}:${session.profiles.evictions?.() ?? 0}`;
    if (epoch !== profilesEpoch) {
      profilesEpoch = epoch;
      profilesEnsured.clear();
    }
    const authors = new Set<string>();
    for (const key of shown.keys()) {
      const author = linkAuthors.get(key);
      if (author && !author.workflow) authors.add(author.id);
    }
    for (const id of profilesEnsured)
      if (!authors.has(id)) profilesEnsured.delete(id);
  }
  /** The channel a byline names: listed, confirmed, not a DM or Solo chat. */
  function linkedChannel(id: string) {
    const c = session.channels.list().channels.find((item) => item.id === id);
    return c && !c.cached && c.channelType !== "dm" && c.channelType !== "solo"
      ? c
      : undefined;
  }
  /** "<author> in #<channel>" for each bare message link in a row whose
   * author main has read and can name; the same words its own links show. */
  function linkLabels(row: ChannelMessage): Record<string, string> | undefined {
    let labels: Record<string, string> | undefined;
    let count = 0;
    for (const link of linksOf(row)) {
      // The native row takes at most 64 labels of bounded URLs.
      if (count >= MAX_LINKS) break;
      if (bytes(link.url) > 8192) continue;
      const channel = linkedChannel(link.channelId);
      const author = linkAuthors.get(`${link.channelId}:${link.messageId}`);
      if (!channel || !author) continue;
      let name = "";
      if (author.workflow) name = "Workflow";
      else {
        if (!profilesEnsured.has(author.id)) {
          profilesEnsured.add(author.id);
          void session.profiles
            .ensure([author.id], "background")
            .catch(() => {});
        }
        name =
          session.names?.resolve(author.id, "", channel.members ?? []) ?? "";
      }
      if (!name) continue;
      const label = `${name} in #${channel.name}`;
      if (bytes(label) > 1000) continue;
      labels ??= {};
      labels[link.url] = label;
      count++;
    }
    return labels;
  }
  /** Typing and agent work for this frame, from the same stores and pure
   * classification main's indicator uses; no step details are projected. */
  function typing(): CompanionTyping | undefined {
    const profiles = session.profiles.snapshot();
    const entries = session.typing
      .snapshot()
      .filter(
        (entry) =>
          entry.channelId === channelId &&
          (rootId ? entry.threadRootId === rootId : !entry.threadRootId),
      );
    const known = knownAgentsOf(
      session.agentChoices.snapshot(),
      session.typing.snapshot(),
      profiles,
    );
    // As main's indicator: a conversation frame hands work at a shown root
    // with replies to that thread, and an agent live activity identifies is
    // never a typing human, whatever its profile says so far.
    const rows = thread?.snapshot().rows ?? [];
    const details = currentActivity(
      session.agentActivity.snapshot(),
      session.typing.snapshot(),
      known,
      channelId,
      rootId,
      false,
      rootId
        ? undefined
        : new Set(
            rows.filter((row) => row.replyCount > 0).map((row) => row.id),
          ),
    );
    const name = (pubkey: string) =>
      (
        profiles.get(pubkey)?.name ??
        formatPublicKey(pubkey) ??
        "Someone"
      ).slice(0, 200);
    const humans = entries
      .filter(
        (entry) =>
          !known.has(entry.pubkey) &&
          !details.has(entry.pubkey) &&
          entry.pubkey !== session.viewer,
      )
      .map((entry) => entry.pubkey);
    const agents = [...details.keys()].sort().slice(0, 8).map(name);
    if (!humans.length && !agents.length) return undefined;
    return {
      humans: humans.slice(0, 2).map(name),
      more: Math.max(0, humans.length - 2),
      agents,
    };
  }
  /** Actions main would offer for a row, by exact contribution instance,
   * within the native DTO's bounds: at most 32, each field ≤256 UTF-8 bytes.
   * Identities are never rewritten; an action that does not fit is left out
   * of this window rather than rejecting the whole presentation. */
  function actionsFor(row: ChannelMessage): CompanionAction[] {
    const fits = (value: string) =>
      new TextEncoder().encode(value).length <= 256;
    return (actions?.snapshot() ?? [])
      .flatMap((action) => {
        if (excludedActions.has(action.id)) return [];
        if (!fits(action.key) || !fits(action.revision) || !fits(action.title))
          return [];
        try {
          return action.matches(row, session)
            ? [
                {
                  key: action.key,
                  revision: action.revision,
                  title: action.title,
                },
              ]
            : [];
        } catch {
          return [];
        }
      })
      .slice(0, 32);
  }
  const channel = () =>
    session.channels.get?.(channelId) ??
    session.channels.list().channels.find((c) => c.id === channelId);
  /** Observe owner evidence for the agent authors shown now, within the
   * bound; authors that left the projection release their observation first. */
  function observeOwners(authors: ReadonlySet<string>) {
    if (disposed) return;
    for (const [authorId, store] of evidence)
      if (!authors.has(authorId)) {
        store.dispose();
        evidence.delete(authorId);
      }
    for (const authorId of authors) {
      if (evidence.has(authorId) || evidence.size >= MAX_EVIDENCE) continue;
      const store = createAgentOwnerEvidence(session, authorId);
      evidence.set(authorId, store);
      store.subscribe(notify);
    }
  }
  /** Agent-owner deletion authority for a row, from verified evidence only. */
  function authorization(row: ChannelMessage) {
    if (!session.viewer || row.authorId === session.viewer) return undefined;
    const proof = evidence.get(row.authorId)?.snapshot();
    return proof?.status === "ready" && proof.owner === session.viewer
      ? { agentId: row.authorId, ownerId: session.viewer }
      : undefined;
  }
  /** The channel is known and readable; says nothing about the root. */
  const available = () => {
    const c = channel();
    return !disposed && !!thread && !!c && !c.cached;
  };
  /** The verified root of this exact thread is loaded in this channel. Replies
   * are offered and admitted only then; a loading root keeps the window open
   * but read-only. */
  const rootVerified = () => {
    const snap = thread?.snapshot();
    if (!available() || snap?.status !== "ready" || snap.error) return false;
    // A conversation frame has no root to verify: its window is ready.
    if (!rootId) return true;
    return snap.root?.id === rootId && snap.root.channelId === channelId;
  };
  // As the main thread composer decides: the relay's readOnly/cached flags,
  // not the roster, which the summary may not carry ("absent means unknown").
  const writable = () => {
    const c = channel();
    return (
      rootVerified() && !!c && !c.archived && !c.readOnly && !!session.viewer
    );
  };
  return {
    available,
    rootVerified,
    writable,
    /** The registered action instance for a handoff, if it still exists and
     * still matches the shown message; disable/reinstall invalidates it. */
    handoff(messageId: string, key: string, revision: string) {
      const row = this.shown(messageId);
      const action = actions
        ?.snapshot()
        .find((entry) => entry.key === key && entry.revision === revision);
      if (!row || !action || excludedActions.has(action.id)) return undefined;
      try {
        return action.matches(row, session) ? action : undefined;
      } catch {
        return undefined;
      }
    },
    /** Verified agent-owner authority for a shown message, or none. */
    authorization(id: string) {
      const row = this.shown(id);
      return row ? authorization(row) : undefined;
    },
    /** A shown message by id, with main's own reaction events, for admission. */
    shown(id: string): ChannelMessage | undefined {
      const snap = thread?.snapshot();
      if (!snap || !available()) return undefined;
      if (snap.root?.id === id) return snap.root;
      return visible(snap.rows, !rootId)
        .slice(-MAX_REPLIES)
        .find((row) => row.id === id);
    },
    /** Main's outbox operations in this channel: the whole collection, for
     * admission and fences; the view serializes a capped copy. Operations are
     * not dropped when their target row leaves the projection. */
    operations(): MainOperation[] {
      const seen = new Set<string>();
      const channelOps: MainOperation[] = (
        session.outbox?.snapshot() ?? []
      ).flatMap((item): MainOperation[] => {
        const kind = item.event.kind;
        if (kind !== 7 && kind !== 5 && kind !== 40003 && kind !== 9) return [];
        if (
          !item.event.tags.some(
            ([name, value]) => name === "h" && value === channelId,
          )
        )
          return [];
        const eTag = item.event.tags.find(([name]) => name === "e")?.[1];
        // A removal of a reaction names the reacted message; a removal of a
        // message names the message itself.
        const messageId =
          kind === 9
            ? item.event.tags.find(([name]) => name === "buzz:copy-of")?.[1]
            : kind === 40003
              ? eTag
              : (session.messages.reactionTarget(item.event) ?? eTag);
        if (kind === 9 && !messageId) return [];
        seen.add(item.event.id);
        return [
          {
            id: item.event.id,
            ...(messageId ? { messageId } : {}),
            kind,
            delivery: item.delivery,
            ...(item.error ? { error: item.error.slice(0, 2048) } : {}),
          },
        ];
      });
      // Admitted here but no longer in main's outbox: delivered and dropped.
      // Reported as accepted until the companion has received that report
      // (`acknowledgePublished`); reading never consumes it.
      const finished: MainOperation[] = [];
      for (const [id, record] of admitted) {
        if (seen.has(id)) continue;
        finished.push({
          id,
          ...(record.messageId ? { messageId: record.messageId } : {}),
          kind: record.kind,
          delivery: "accepted",
        });
      }
      // This window's own first, so a capped presentation keeps them and
      // their terminal states cannot be displaced by other operations.
      const own = channelOps.filter((op) => admitted.has(op.id));
      const others = channelOps.filter((op) => !admitted.has(op.id));
      return [...finished, ...own, ...others];
    },
    /** The companion reconciled these terminal reports: forget them. Only
     * ids whose current report is terminal retire; nothing else is affected. */
    acknowledge(ids: readonly string[]) {
      const terminal = new Set(
        this.operations()
          .filter((op) => op.delivery === "accepted" || op.delivery === "seen")
          .map((op) => op.id),
      );
      let retired = false;
      for (const id of ids)
        if (admitted.has(id) && terminal.has(id)) {
          admitted.delete(id);
          retired = true;
        }
      return retired;
    },
    /** Main admitted this operation for this window. */
    admit(
      id: string,
      messageId: string | undefined,
      kind: MainOperation["kind"],
    ) {
      if (admitted.size >= MAX_ADMITTED) {
        const oldest = admitted.keys().next().value;
        if (oldest) admitted.delete(oldest);
      }
      admitted.set(id, { messageId, kind });
    },
    /** An unresolved reaction change is still in flight for this message. */
    reactionBusy(messageId: string) {
      return this.operations().some(
        (op) =>
          op.messageId === messageId &&
          (op.kind === 7 || op.kind === 5) &&
          ["sending", "failed", "unknown"].includes(op.delivery),
      );
    },
    /** Retry an operation main admitted for this window; nothing else. */
    retryOperation(id: string) {
      if (!admitted.has(id)) return false;
      session.outbox?.retry(id, writable);
      return true;
    },
    /** Ids this window presents; the reading owner claims nothing else. */
    known(): ReadonlySet<string> {
      const snap = thread?.snapshot();
      return new Set(
        snap && available()
          ? [snap.root, ...visible(snap.rows, !rootId).slice(-MAX_REPLIES)]
              .filter((row) => row !== undefined)
              .map((row) => row.id)
          : [],
      );
    },
    readingEnabled: () =>
      available() && session.unread.sync().capability === "frontier-sync",
    snapshot(): PopoutThreadView {
      const snap = thread?.snapshot();
      const profiles = session.profiles.snapshot();
      const replies = snap ? visible(snap.rows, !rootId) : [];
      // Agent hints decide whose ownership to observe; evidence decides
      // authority. Observation follows the rows shown now.
      // The same bounded rows the window shows, admits and claims read.
      const shownRows = snap
        ? [snap.root, ...replies.slice(-MAX_REPLIES)].filter(Boolean)
        : [];
      observeOwners(
        new Set(
          (shownRows as ChannelMessage[])
            .filter(
              (row) =>
                row.authorId !== session.viewer &&
                (row.agentEnvelope || profiles.get(row.authorId)?.isAgent),
            )
            .map((row) => row.authorId),
        ),
      );
      observeLinks(shownRows as ChannelMessage[]);
      const c = channel();
      const joined =
        !!c && !c.cached && (!c.readOnly || c.viewerRole === "guest");
      const channelWritable = !!c && !c.readOnly && !c.cached;
      const archived = !!c?.archived;
      const project = (row: ChannelMessage) => {
        const labels = linkLabels(row);
        const projected = {
          ...projectCompanionRow(session, profiles, row, channelId),
          ...(labels ? { linkLabels: labels } : {}),
        };
        const delivered =
          !row.delivery || ["accepted", "seen"].includes(row.delivery);
        if (!joined || row.membership || row.diff || !delivered)
          return projected;
        const own = row.authorId === session.viewer && !archived;
        // The same single-row predicate the main menu uses.
        const canEdit =
          channelWritable && own && !!lastEditableMessage(session, [row]);
        const owned = !archived && !!authorization(row);
        const attention = session.unread.attention(channelId, row.id);
        const offered = actionsFor(row);
        return {
          ...projected,
          ...(offered.length ? { actions: offered } : {}),
          management: {
            unread: attention.unread || attention.forced,
            canEdit,
            canDelete:
              ((channelWritable && own) || owned) &&
              !!session.outbox?.supports(5),
            canSendToChannel:
              channelWritable &&
              own &&
              !!row.threadRootId &&
              !row.agentEnvelope &&
              !row.diff &&
              !!session.outbox?.supports(9),
            canReport: !row.huddle && !!session.messages.report,
          } satisfies CompanionManagement,
          ...(canEdit
            ? {
                editable: {
                  sourceContent: row.sourceContent ?? row.content,
                  attachmentSourceId: row.attachmentSourceId ?? row.id,
                },
                // An edit needs the whole text, not the presentation slice.
                text: row.content,
              }
            : {}),
        };
      };
      return {
        title: (channel()?.name ?? "Conversation").slice(0, 1000),
        scope: session.scope.slice(0, 4096),
        status:
          error || snap?.status === "error"
            ? "error"
            : snap?.status === "ready"
              ? "ready"
              : "loading",
        error: error ?? snap?.error,
        writable: writable(),
        canLoadMore: !!snap?.canLoadMore,
        limited: !!snap?.limited || replies.length > MAX_REPLIES,
        loadingOlder: !!snap?.loadingOlder,
        readingRevision: session.unread.revision(),
        version,
        root: snap?.root && available() ? project(snap.root) : undefined,
        replies: available() ? replies.slice(-MAX_REPLIES).map(project) : [],
        operations: this.operations().slice(0, MAX_OPERATIONS),
        following: rootId ? session.unread.following(channelId, rootId) : false,
        isDm: c?.channelType === "dm" || c?.channelType === "solo",
        thread: !!rootId,
        typing: available() ? typing() : undefined,
      };
    },
    retry() {
      if (!thread || disposed) return;
      error = undefined;
      thread.refresh();
      notify();
    },
    older() {
      if (!thread || disposed || !available()) return;
      thread.older();
    },
    recover(id: string, dismiss = false) {
      const item = session.outbox
        ?.snapshot()
        .find(
          (item) =>
            item.event.id === id &&
            item.event.pubkey === session.viewer &&
            ["failed", "unknown"].includes(item.delivery) &&
            item.event.tags.some((t) => t[0] === "h" && t[1] === channelId),
        );
      if (disposed || !available() || !item) return;
      if (dismiss)
        void session.outbox?.dismiss(id).catch(() => {
          error = "Couldn’t discard this message.";
          notify();
        });
      else if (writable()) session.outbox?.retry(id, writable);
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop?.();
      for (const store of evidence.values()) store.dispose();
      evidence.clear();
      for (const release of linksWanted.values()) release();
      linksWanted.clear();
      thread?.dispose();
    },
  };
}
