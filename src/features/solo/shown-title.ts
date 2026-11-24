import {
  attachmentSummary,
  markdownImageKind,
} from "../relay/attachment-summary";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import type { Attachment } from "../relay/contracts";

/** A title for text that is only web links, which read as noise: the site of
 * one, or how many. Undefined when the text says anything else. */
export function linkTitle(text: string): string | undefined {
  const links = text.split(/\s+/).filter(Boolean);
  const sites: string[] = [];
  for (const link of links) {
    const url = /^<?(https?:\/\/[^\s<>]+)>?$/i.exec(link)?.[1];
    if (!url) return undefined;
    try {
      sites.push(new URL(url).hostname.replace(/^www\./, ""));
    } catch {
      sites.push("");
    }
  }
  if (!links.length) return undefined;
  if (links.length > 1) return `${links.length} links`;
  return sites[0] ? `Link to ${sites[0]}` : "Link";
}

// An embed or a web link as a name keeps it: whole, or cut off at its address
// by the name's length limit.
const label = String.raw`\[((?:\\.|[^\]\\])*)\]`;
const embed = new RegExp(String.raw`!${label}\(<?([^\s()<>]*)(?:>?\)|$)`, "gu");
const link = new RegExp(
  String.raw`${label}\(<?https?:\/\/[^\s()<>]*(?:>?\)|$)`,
  "giu",
);

function embedKind(alt: string, url: string): Attachment["kind"] {
  const named = alt.toLowerCase();
  if (named === "audio") return "audio";
  return named === "video" || /\.(mp4|webm|mov)$/.test(named)
    ? "video"
    : markdownImageKind(url);
}

/**
 * A Solo chat's name as its title shows it. A client that names a chat after
 * its first message's source can store an embed or a link as that name; it
 * reads as the title a new chat gets for the same message. Any other name is
 * shown as it is.
 */
export function shownChatTitle(name: string): string {
  if (!/\]\(|^<?https?:\/\//i.test(name)) return name;
  const media: Pick<Attachment, "kind">[] = [];
  const text = canonicalDetailsName(
    name
      .replace(embed, (_source, alt: string, url: string) => {
        media.push({ kind: embedKind(alt, url) });
        return " ";
      })
      .replace(link, (_source, text: string) => text.replace(/\\(.)/gu, "$1"))
      .replace(/\s+/g, " "),
  );
  return linkTitle(text) ?? (text || attachmentSummary(media) || name);
}
