// Synchronous hover and focus capture when a voice action shortcut fires.
// Reads existing DOM markers (`data-message-id`, `data-channel-id`,
// `data-sidebar-section`, `data-agent`, `data-member`, `data-channel-header`,
// `data-community-id`) before the VoiceJump modal mounts and steals focus.
import { messagePreviewText } from "../conversation/message-preview-text";
import { sortParticipantNames } from "../identity-names/participant-order";
import { isBuzzLink } from "../navigation/buzz-links";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

export type VoiceSlotKind =
  | "message"
  | "channel"
  | "section"
  | "person"
  | "agent"
  | "thread"
  | "community"
  | "emoji"
  | "text";

export type VoiceThing =
  | Readonly<{
      kind: "message";
      id: string;
      channelId: string;
      threadRootId?: string | undefined;
      authorId?: string | undefined;
      authorName?: string | undefined;
      preview?: string | undefined;
      label: string;
    }>
  | Readonly<{
      kind: "channel";
      id: string;
      name: string;
      channelType?: ChannelSummary["channelType"] | undefined;
      sectionKey?: string | undefined;
      starred?: boolean | undefined;
      peerPubkey?: string | undefined;
      label: string;
    }>
  | Readonly<{
      kind: "section";
      id: string;
      sectionId?: string | undefined;
      name: string;
      label: string;
    }>
  | Readonly<{
      kind: "person";
      id: string;
      name: string;
      channelId?: string | undefined;
      label: string;
    }>
  | Readonly<{
      kind: "agent";
      id: string;
      name: string;
      label: string;
    }>
  | Readonly<{
      kind: "thread";
      id: string;
      channelId: string;
      name?: string | undefined;
      label: string;
    }>
  | Readonly<{
      kind: "community";
      id: string;
      name: string;
      label: string;
    }>
  | Readonly<{
      kind: "nothing";
      activeChannelId?: string | undefined;
      activeChannelName?: string | undefined;
      label: string;
    }>;

export type PointerSnapshot = Readonly<{
  x: number;
  y: number;
  inside: boolean;
  pointerAt?: number | undefined;
  focusAt?: number | undefined;
}>;

const PREVIEW_LIMIT = 80;
const HEX64 = /^[0-9a-f]{64}$/i;

function clipPreview(text: string): string {
  const line = messagePreviewText(text).replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > PREVIEW_LIMIT
    ? `${line.slice(0, PREVIEW_LIMIT - 1)}…`
    : line;
}

/** Tracks the latest pointer coordinates and focus changes passively so
 * shortcut handlers know which moved last before any modal mounts. */
export function trackPointerPosition(
  target: Window | undefined = typeof window !== "undefined"
    ? window
    : undefined,
): {
  current: () => PointerSnapshot;
  /** Discounts focus moves so far, and any until the next key or pointer
   * input: the voice box's own focus, and focus returning when it closes,
   * are not the person moving focus. */
  forgetFocus: () => void;
  stop: () => void;
} {
  let seq = 0;
  let ignoringFocus = false;
  let state: PointerSnapshot = {
    x: 0,
    y: 0,
    inside: false,
    pointerAt: 0,
    focusAt: 0,
  };
  if (!target)
    return { current: () => state, forgetFocus: () => {}, stop: () => {} };
  const onInput = () => {
    ignoringFocus = false;
  };
  const onMove = (event: PointerEvent | MouseEvent) => {
    ignoringFocus = false;
    state = {
      ...state,
      x: event.clientX,
      y: event.clientY,
      inside: true,
      pointerAt: ++seq,
    };
  };
  const onLeave = () => {
    state = { ...state, inside: false };
  };
  const onFocus = (event: FocusEvent) => {
    const doc = target.document;
    if (
      ignoringFocus ||
      event.target === target ||
      event.target === doc ||
      event.target === doc?.body ||
      event.target === doc?.documentElement
    ) {
      return;
    }
    state = { ...state, focusAt: ++seq };
  };
  const docEl = target.document?.documentElement;
  target.addEventListener("pointermove", onMove, {
    passive: true,
    capture: true,
  });
  target.addEventListener("pointerdown", onMove, {
    passive: true,
    capture: true,
  });
  target.addEventListener("blur", onLeave, { passive: true });
  target.addEventListener("focusin", onFocus, {
    passive: true,
    capture: true,
  });
  target.addEventListener("keydown", onInput, { passive: true, capture: true });
  docEl?.addEventListener("mouseleave", onLeave, { passive: true });
  return {
    current: () => state,
    forgetFocus: () => {
      ignoringFocus = true;
      state = { ...state, focusAt: 0 };
    },
    stop: () => {
      target.removeEventListener("keydown", onInput, { capture: true });
      target.removeEventListener("pointermove", onMove, { capture: true });
      target.removeEventListener("pointerdown", onMove, { capture: true });
      target.removeEventListener("blur", onLeave);
      target.removeEventListener("focusin", onFocus, { capture: true });
      docEl?.removeEventListener("mouseleave", onLeave);
    },
  };
}

export function channelDisplayName(
  channel: ChannelSummary,
  session: RelaySession | undefined,
  resolveName?: (
    pubkey: string,
    fallback: string,
    among?: readonly string[],
  ) => string,
): string {
  if (channel.channelType === "dm" && channel.participants) {
    const profiles = session?.profiles.snapshot();
    const person = (id: string) => {
      const fallback = profiles?.get(id)?.name ?? id.slice(0, 10);
      return resolveName
        ? resolveName(id, fallback, channel.participants)
        : fallback;
    };
    return (
      sortParticipantNames(channel.participants.map(person)).join(", ") ||
      "Notes to self"
    );
  }
  return channel.name;
}

function sectionDisplayName(
  sectionKey: string,
  sectionEl: Element,
  session: RelaySession | undefined,
): { sectionId?: string | undefined; name: string } {
  const sectionId = sectionKey.startsWith("group:")
    ? sectionKey.slice("group:".length)
    : undefined;
  if (sectionId) {
    const saved = session?.sidebarPreferences
      .snapshot()
      .data?.sections.find((s) => s.id === sectionId);
    if (saved?.name) return { sectionId, name: saved.name };
  }
  if (sectionKey === "starred") return { name: "Starred" };
  if (sectionKey === "channels") return { name: "Channels" };
  if (sectionKey === "forums") return { name: "Forums" };
  if (sectionKey === "dms") return { name: "Direct messages" };
  const domTitle = sectionEl
    .querySelector("summary")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return {
    ...(sectionId ? { sectionId } : {}),
    name: domTitle || sectionKey,
  };
}

function channelThing(
  channelId: string,
  sectionKey: string | undefined,
  domFallbackName: string | undefined,
  session: RelaySession | undefined,
  resolveName?: (
    pubkey: string,
    fallback: string,
    among?: readonly string[],
  ) => string,
): VoiceThing {
  const channel =
    session?.channels.get?.(channelId) ??
    session?.channels.list().channels.find((c) => c.id === channelId);
  const name = channel
    ? channelDisplayName(channel, session, resolveName)
    : domFallbackName || channelId;
  const starred =
    session?.sidebarPreferences.snapshot().data?.starred.includes(channelId) ??
    (sectionKey === "starred" ? true : undefined);
  const peerPubkey =
    channel?.channelType === "dm" && channel.participants?.length === 1
      ? channel.participants[0]
      : undefined;
  const label =
    channel?.channelType === "dm"
      ? `DM with ${name}`
      : channel?.channelType === "solo"
        ? name
        : `#${name}`;
  return {
    kind: "channel",
    id: channelId,
    name,
    ...(channel?.channelType ? { channelType: channel.channelType } : {}),
    ...(sectionKey ? { sectionKey } : {}),
    ...(starred !== undefined ? { starred } : {}),
    ...(peerPubkey ? { peerPubkey } : {}),
    label,
  };
}

function captureFromElement(
  element: Element,
  {
    session,
    resolveName,
    activeChannelId,
  }: {
    session?: RelaySession | undefined;
    resolveName?:
      | ((
          pubkey: string,
          fallback: string,
          among?: readonly string[],
        ) => string)
      | undefined;
    activeChannelId?: string | undefined;
  },
): VoiceThing | undefined {
  // 1. Message row (in channel timeline or open thread panel).
  const messageEl = element.closest<HTMLElement>("[data-message-id]");
  if (messageEl) {
    const messageId = messageEl.getAttribute("data-message-id");
    if (messageId) {
      const channelId =
        messageEl
          .closest<HTMLElement>("[data-channel-timeline]")
          ?.getAttribute("data-channel-timeline") ??
        messageEl
          .closest<HTMLElement>("[data-thread-channel]")
          ?.getAttribute("data-thread-channel") ??
        activeChannelId;
      if (channelId) {
        const row = session?.channels
          .window(channelId)
          .rows.find((candidate) => candidate.id === messageId);
        const threadRootAttr = messageEl
          .closest<HTMLElement>("[data-thread-root]")
          ?.getAttribute("data-thread-root");
        const threadRootId =
          row?.threadRootId ??
          (row?.replyCount ? row.id : undefined) ??
          (threadRootAttr || undefined);
        const authorId = row?.workflowOwnerId ?? row?.authorId;
        const profiles = session?.profiles.snapshot();
        const domAuthor = messageEl
          .querySelector("[data-message-author]")
          ?.textContent?.trim();
        const authorName = authorId
          ? resolveName
            ? resolveName(
                authorId,
                profiles?.get(authorId)?.name ?? authorId.slice(0, 10),
              )
            : (profiles?.get(authorId)?.name ?? domAuthor)
          : domAuthor || undefined;
        const preview = row ? clipPreview(row.content) : undefined;
        const label = authorName
          ? preview
            ? `message from ${authorName}: "${preview}"`
            : `message from ${authorName}`
          : "this message";
        return {
          kind: "message",
          id: messageId,
          channelId,
          ...(threadRootId ? { threadRootId } : {}),
          ...(authorId ? { authorId } : {}),
          ...(authorName ? { authorName } : {}),
          ...(preview ? { preview } : {}),
          label,
        };
      }
    }
  }

  // 2. Channel or Solo row in sidebar (must precede section check, since rows live inside sections).
  const channelRow = element.closest<HTMLElement>(
    "[data-channel-id], [data-solo-channel-id]",
  );
  if (channelRow) {
    const channelId =
      channelRow.getAttribute("data-channel-id") ??
      channelRow.getAttribute("data-solo-channel-id");
    if (channelId) {
      const sectionKey =
        channelRow
          .closest<HTMLElement>("[data-sidebar-section]")
          ?.getAttribute("data-sidebar-section") ?? undefined;
      const domName = channelRow.textContent?.replace(/\s+/g, " ").trim();
      return channelThing(channelId, sectionKey, domName, session, resolveName);
    }
  }

  // 3. Channel header identity button.
  const channelHeader = element.closest<HTMLElement>("[data-channel-header]");
  if (channelHeader) {
    const channelId = channelHeader.getAttribute("data-channel-header");
    if (channelId) {
      return channelThing(
        channelId,
        undefined,
        channelHeader.textContent?.replace(/\s+/g, " ").trim(),
        session,
        resolveName,
      );
    }
  }

  // 4. Sidebar section header / container (when not on a channel row).
  const sectionEl = element.closest<HTMLElement>("[data-sidebar-section]");
  if (sectionEl) {
    const sectionKey = sectionEl.getAttribute("data-sidebar-section");
    if (sectionKey) {
      const { sectionId, name } = sectionDisplayName(
        sectionKey,
        sectionEl,
        session,
      );
      return {
        kind: "section",
        id: sectionKey,
        ...(sectionId ? { sectionId } : {}),
        name,
        label: `section ${name}`,
      };
    }
  }

  // 5. Agent card or badge.
  const agentEl = element.closest<HTMLElement>("[data-agent]");
  if (agentEl) {
    const agentId = agentEl.getAttribute("data-agent");
    if (agentId) {
      const identity = session?.agentChoices
        .snapshot()
        .identities.find((item) => item.pubkey === agentId);
      const profileName = session?.profiles.snapshot().get(agentId)?.name;
      const ariaName = agentEl
        .getAttribute("aria-label")
        ?.split(",")[0]
        ?.trim();
      const name =
        identity?.name ?? profileName ?? ariaName ?? agentId.slice(0, 10);
      return {
        kind: "agent",
        id: agentId,
        name,
        label: name,
      };
    }
  }

  // 6. Member / person row.
  const memberEl = element.closest<HTMLElement>(
    "[data-member], [data-member-row]",
  );
  if (memberEl) {
    const rawId =
      memberEl.getAttribute("data-member") ??
      memberEl.getAttribute("data-member-row");
    if (rawId && HEX64.test(rawId)) {
      const profileName = session?.profiles.snapshot().get(rawId)?.name;
      const name = resolveName
        ? resolveName(rawId, profileName ?? rawId.slice(0, 10))
        : (profileName ?? rawId.slice(0, 10));
      return {
        kind: "person",
        id: rawId,
        name,
        ...(activeChannelId ? { channelId: activeChannelId } : {}),
        label: name,
      };
    }
  }

  // 7. Community item.
  const communityEl = element.closest<HTMLElement>("[data-community-id]");
  if (communityEl) {
    const communityId = communityEl.getAttribute("data-community-id");
    if (communityId) {
      const name =
        communityEl.getAttribute("aria-label") ??
        communityEl.textContent?.replace(/\s+/g, " ").trim() ??
        communityId;
      return {
        kind: "community",
        id: communityId,
        name,
        label: name,
      };
    }
  }

  return undefined;
}

/** Captures the typed UI target currently under the pointer (falling back to
 * `document.activeElement` when pointer coordinates aren't available). */
export function captureVoiceThing({
  pointer,
  doc = typeof document !== "undefined" ? document : undefined,
  session,
  resolveName,
  activeChannelId,
}: {
  pointer?: PointerSnapshot | undefined;
  doc?: Document | undefined;
  session?: RelaySession | undefined;
  resolveName?:
    | ((pubkey: string, fallback: string, among?: readonly string[]) => string)
    | undefined;
  activeChannelId?: string | undefined;
}): VoiceThing {
  const candidates: Element[] = [];
  const active =
    doc?.activeElement &&
    doc.activeElement !== doc.body &&
    doc.activeElement !== doc.documentElement
      ? doc.activeElement
      : undefined;
  const focusMoreRecent = (pointer?.focusAt ?? 0) > (pointer?.pointerAt ?? 0);

  if (focusMoreRecent) {
    if (active) candidates.push(active);
  } else {
    if (doc && pointer?.inside && typeof doc.elementsFromPoint === "function") {
      candidates.push(...doc.elementsFromPoint(pointer.x, pointer.y));
    }
    if (active) candidates.push(active);
  }
  for (const element of candidates) {
    const captured = captureFromElement(element, {
      session,
      resolveName,
      activeChannelId,
    });
    if (captured) return captured;
  }
  const activeChannel = activeChannelId
    ? (session?.channels.get?.(activeChannelId) ??
      session?.channels.list().channels.find((c) => c.id === activeChannelId))
    : undefined;
  const activeChannelName = activeChannel
    ? channelDisplayName(activeChannel, session, resolveName)
    : undefined;
  return {
    kind: "nothing",
    ...(activeChannelId ? { activeChannelId } : {}),
    ...(activeChannelName ? { activeChannelName } : {}),
    label: "nothing",
  };
}

const MIDDLE_CLICK_EXCLUDED_SELECTOR =
  'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"]), iframe, webview, section[aria-label="Browser"], [data-closable]';

function isBuzzLinkAnchor(element: Element): boolean {
  if (!element.matches("a[href]")) return false;
  const href = element.getAttribute("href") ?? "";
  return isBuzzLink(href) || element.hasAttribute("data-panel-target");
}

/** Elements in a middle-click event's path, innermost first. */
export function middleClickElements(event: MouseEvent): Element[] {
  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements = path.filter(
    (node): node is Element => node instanceof Element,
  );
  if (elements.length > 0) return elements;
  if (event.target instanceof Element) return [event.target];
  if (event.target instanceof Node && event.target.parentElement) {
    return [event.target.parentElement];
  }
  return [];
}

/** Middle-clicks on closable tabs, Buzz links, text fields, and embedded web
 * pages keep their own behavior rather than driving voice. */
export function isMiddleClickExcluded(
  event: MouseEvent,
  elements: readonly Element[] = middleClickElements(event),
): boolean {
  for (const element of elements) {
    if (
      (element as HTMLElement).isContentEditable ||
      element.matches(MIDDLE_CLICK_EXCLUDED_SELECTOR) ||
      isBuzzLinkAnchor(element)
    ) {
      return true;
    }
  }
  const target = elements[0];
  if (!target) return true;
  if (target.closest(MIDDLE_CLICK_EXCLUDED_SELECTOR)) return true;
  const anchor = target.closest("a[href]");
  return !!anchor && isBuzzLinkAnchor(anchor);
}

/** Captures the typed UI target from a directly clicked DOM element, or
 * `undefined` when the element is not something voice can target. */
export function captureVoiceThingFromElement(
  element: Element | null | undefined,
  {
    session,
    resolveName,
    activeChannelId,
  }: {
    session?: RelaySession | undefined;
    resolveName?:
      | ((
          pubkey: string,
          fallback: string,
          among?: readonly string[],
        ) => string)
      | undefined;
    activeChannelId?: string | undefined;
  } = {},
): VoiceThing | undefined {
  if (!element) return undefined;
  return captureFromElement(element, {
    session,
    resolveName,
    activeChannelId,
  });
}
