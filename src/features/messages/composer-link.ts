import { parseBuzzLink } from "../navigation/buzz-links";
import { safeLinkUrl } from "../relay/message-content";

/** Match message navigation policy; never put an unchecked href in the editor. */
export function composerLinkUrl(value: string): string | undefined {
  const href = value.trim();
  return parseBuzzLink(href) ? href : safeLinkUrl(href);
}
