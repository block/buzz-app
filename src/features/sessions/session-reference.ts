import { parseBuzzLink } from "../navigation/buzz-links";
import { parseOpenTarget, type NavigationScope } from "../navigation/targets";

export type SessionReference = Readonly<{ href: string; label: string }>;

/** Ordinary community-relative Buzz message links own routing, not the label. */
export function sessionReference(
  scope: NavigationScope,
  channelId: string,
  rootId: string,
  title: string,
): SessionReference {
  const target = parseOpenTarget({
    version: 1,
    kind: "conversation",
    scope,
    channelId,
    messageId: rootId,
    threadRootId: rootId,
  });
  if (
    target.kind !== "conversation" ||
    !target.messageId ||
    !target.threadRootId
  )
    throw new Error("Invalid session reference");
  const params = new URLSearchParams({
    channel: target.channelId,
    id: target.messageId,
    thread: target.threadRootId,
  });
  return {
    href: `buzz://message?${params}`,
    label: `Session: ${title.trim().replace(/\s+/g, " ").slice(0, 160) || "Session"}`,
  };
}

export function sessionReferenceTarget(href: string) {
  const target = parseBuzzLink(href);
  return target?.format === "legacy" &&
    target.messageId &&
    target.messageId === target.threadRootId
    ? target
    : undefined;
}

export function sessionReferenceTitle(href: string, label: string) {
  return sessionReferenceTarget(href) && /^Session: [^\r\n]{1,160}$/.test(label)
    ? label.slice("Session: ".length)
    : undefined;
}

/** Escape all Markdown punctuation, including HTML/entity delimiters. */
export function referenceMarkdown(reference: SessionReference) {
  if (!sessionReferenceTitle(reference.href, reference.label)) return undefined;
  const label = reference.label.replace(
    /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g,
    "\\$&",
  );
  return `[${label}](${reference.href})`;
}
