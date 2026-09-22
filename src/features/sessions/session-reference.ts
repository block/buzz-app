import {
  parseTargetLink,
  targetLink,
  type NavigationScope,
} from "../navigation/targets";

export type SessionReference = Readonly<{ href: string; label: string }>;

/** Presentation only: the ordinary, viewer-free conversation locator owns routing. */
export function sessionReference(
  scope: NavigationScope,
  channelId: string,
  rootId: string,
  title: string,
): SessionReference {
  return {
    href: targetLink({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      messageId: rootId,
      threadRootId: rootId,
    }),
    label: `Session: ${title.trim().replace(/\s+/g, " ").slice(0, 160) || "Session"}`,
  };
}

export function sessionReferenceTarget(href: string) {
  try {
    const target = parseTargetLink(href);
    return target.kind === "conversation" &&
      target.messageId &&
      target.messageId === target.threadRootId &&
      targetLink({
        ...target,
        scope: { ...target.scope, viewer: "0".repeat(64) },
      }) === href
      ? target
      : undefined;
  } catch {
    return undefined;
  }
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
