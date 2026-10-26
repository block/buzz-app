import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

/** Render Markdown as React nodes; raw HTML and executable links stay inert. */
export function markdown(react: typeof import("react"), text: string) {
  const h = react.createElement;
  const tree = fromMarkdown(text);
  const definitions = new Map(
    tree.children
      .filter((node) => node.type === "definition")
      .map((node) => [node.identifier.toLowerCase(), node.url]),
  );
  const render = (
    node: Nodes,
    key = 0,
  ): ReturnType<typeof h> | string | null => {
    const children =
      "children" in node
        ? node.children.map((child, index) => render(child, index))
        : [];
    const element = (tag: string, props = {}) =>
      h(tag, { key, ...props }, ...children);
    switch (node.type) {
      case "root":
        return element("div", {
          className: "attention-markdown text-body-sm text-secondary",
        });
      case "text":
        return node.value;
      case "paragraph":
        return element("p");
      case "heading":
        return element(`h${node.depth}`);
      case "strong":
        return element("strong");
      case "emphasis":
        return element("em");
      case "inlineCode":
        return h("code", { key }, node.value);
      case "code":
        return h("pre", { key }, h("code", null, node.value));
      case "list":
        return element(
          node.ordered ? "ol" : "ul",
          node.ordered && node.start ? { start: node.start } : {},
        );
      case "listItem":
        return element("li");
      case "blockquote":
        return element("blockquote");
      case "break":
        return h("br", { key });
      case "thematicBreak":
        return h("hr", { key });
      case "link":
      case "linkReference": {
        const url =
          node.type === "link"
            ? node.url
            : definitions.get(node.identifier.toLowerCase());
        return url && /^(https?:|mailto:|buzz:|nostr:|#)/i.test(url)
          ? element("a", { href: url, rel: "noreferrer", target: "_blank" })
          : element("span");
      }
      case "imageReference":
      case "image":
        return node.alt ?? "";
      case "html":
        return node.value;
      default:
        return null;
    }
  };
  return render(tree);
}
