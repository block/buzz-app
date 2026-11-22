import { communityDestination } from "../communities/destination";
import type { ClientSnapshot } from "../communities/service";
import { isNativeMediaSource } from "../messages/attachment-source";
import type { Attachment } from "../relay/contracts";

const INTERNAL_SCHEME = "buzz:";
const INTERNAL_PATH = "html-preview";
const RELAY_HTML_PATH = /^\/media\/[0-9a-f]{64}\.html?$/;

export type HtmlPreviewTarget = Readonly<{
  source: string;
  name: string;
  label: string;
  fragment: string;
}>;

export function isHtmlAttachment(attachment: Attachment): boolean {
  if (attachment.kind !== "file") return false;
  const mime = attachment.mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") return true;
  return /\.html?$/i.test(attachment.name ?? "");
}

export function htmlAttachmentTarget(
  source: string | undefined,
  name?: string,
): string | undefined {
  if (!source || !isNativeMediaSource(source)) return undefined;
  const params = new URLSearchParams({ source });
  if (name) params.set("name", name);
  return `${INTERNAL_SCHEME}${INTERNAL_PATH}?${params.toString()}`;
}

export function joinedRelayOrigins(
  communities: ClientSnapshot,
  selectedRelay?: string,
): ReadonlySet<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined | null) => {
    if (!value) return;
    try {
      origins.add(communityDestination(value).url);
    } catch {
      // Unresolved deployment aliases carry no relay origin until resolved.
    }
  };
  for (const membership of communities.memberships) add(membership.id);
  add(communities.selected);
  add(selectedRelay);
  return origins;
}

function nativeMediaInnerUrl(source: string): URL | undefined {
  if (!isNativeMediaSource(source)) return undefined;
  try {
    const outer = new URL(source);
    return new URL(decodeURIComponent(outer.pathname.slice(1)));
  } catch {
    // `isNativeMediaSource` already validated the encoded URL; guard defensively.
    return undefined;
  }
}

function shortBlobLabel(pathname: string): string {
  const base = pathname.split("/").at(-1) ?? "HTML preview";
  const dot = base.indexOf(".");
  if (dot > 8) return `${base.slice(0, 8)}…${base.slice(dot)}`;
  return base;
}

export function parseHtmlPreviewTarget(
  target: string,
  origins: ReadonlySet<string>,
): HtmlPreviewTarget | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    // Non-URL panel targets belong to other contributions.
    return undefined;
  }

  if (url.protocol === INTERNAL_SCHEME) {
    if (
      url.hostname ||
      url.pathname !== INTERNAL_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some(
        (key) => key !== "source" && key !== "name",
      )
    )
      return undefined;
    const source = url.searchParams.get("source");
    if (!source) return undefined;
    const media = nativeMediaInnerUrl(source);
    if (!media || !origins.has(media.origin)) return undefined;
    const name = url.searchParams.get("name") ?? "";
    const label = name.trim() || shortBlobLabel(media.pathname);
    return { source, name, label, fragment: "" };
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    !origins.has(url.origin) ||
    !RELAY_HTML_PATH.test(url.pathname)
  )
    return undefined;

  if (url.hash && (url.hash.length > 513 || /\p{Cc}/u.test(url.hash)))
    return undefined;

  const base = url.pathname.split("/").at(-1) ?? "page.html";
  return {
    source: `${url.origin}${url.pathname}`,
    name: base,
    label: shortBlobLabel(url.pathname),
    fragment: url.hash,
  };
}
