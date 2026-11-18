import { agentCardLinkId } from "../agents/AgentCardLink";
import { linkKind } from "../links/InlineLink";

const MAX_URL = 2048;

/** Names that only mean something on this computer or a private network.
 * The host refuses private addresses itself; these never reach DNS. */
const LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "lan",
  "home",
  "internal",
  "intranet",
  "corp",
  "arpa",
  "localdomain",
  "test",
  "invalid",
  "example",
  "onion",
  "svc",
  "consul",
  "ts.net",
];

/** Whether a link, or a hop it redirects to, may be read for a preview:
 * HTTPS on port 443 to a public-looking name, with no credentials or IP
 * literal. Checked again on every redirect. */
export function previewable(href: string): URL | null {
  if (href.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(host)) return null;
  if (/^\d+$/.test(host.split(".").pop() ?? "") || /^0x/i.test(host))
    return null;
  if (
    LOCAL_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  )
    return null;
  return url;
}

/** The link's own domain, which the card shows: a page can't name itself
 * as another site. */
export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/\.+$/, "").replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Links that get a page card. Recognised services, Buzz links and agent
 * share links already show a labelled inline link or card, so a page card
 * would repeat them. */
export const wantsCard = (href: string) =>
  linkKind(href) === "web" &&
  agentCardLinkId(href) === null &&
  !!previewable(href);

/** A hostname as its subdomains, the label most likely to name its owner, and
 * a suffix that is always shown, so a card short of room drops subdomains
 * first. Without the public suffix list, a two-letter country code keeps the
 * label before it in the suffix, which covers co.uk and ne.jp and, under a
 * country that registers directly, shows one label more than it needs. */
export function splitHost(host: string) {
  const labels = host.split(".").filter(Boolean);
  const keep = labels.length > 2 && labels.at(-1)?.length === 2 ? 2 : 1;
  const at = Math.max(0, labels.length - keep - 1);
  return {
    subdomains: labels
      .slice(0, at)
      .map((label) => `${label}.`)
      .join(""),
    name: labels[at] ?? host,
    suffix: labels
      .slice(at + 1)
      .map((label) => `.${label}`)
      .join(""),
  };
}
