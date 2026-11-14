import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import { parseBuzzLink } from "../navigation/buzz-links";
import { safeLinkUrl } from "../relay/message-content";
import type { MarkdownProfile } from "./profiles";

const COMMENT = /^<!--[\s\S]*-->$/;

/** Drops `<!-- comments -->`, which Markdown leaves unseen; other raw HTML still shows as text. */
function remarkDropComments() {
  const drop = (node: Nodes) => {
    if (!("children" in node)) return;
    node.children = node.children.filter(
      (child) => !(child.type === "html" && COMMENT.test(child.value.trim())),
    ) as typeof node.children;
    node.children.forEach(drop);
  };
  return drop;
}

/** Canvas and Notes: GFM, raw HTML shown as text except comments, and only Buzz or safe links. */
export const DOCUMENT_PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [remarkDropComments],
  html: "literal",
  urlTransform: (url) =>
    parseBuzzLink(url) ? url : (safeLinkUrl(url) ?? null),
};

/** GFM pads every table row to its header's width, so a small sparse table
 * can still expand to many cells. */
export const DOCUMENT_RENDER_CELLS = 10_000;
