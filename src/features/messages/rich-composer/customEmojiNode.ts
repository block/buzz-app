import { Node } from "@tiptap/core";

export const CUSTOM_EMOJI_NODE = "customEmoji";
export const CustomEmojiNode = Node.create({
  name: CUSTOM_EMOJI_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { source: { default: "" }, url: { default: "" } };
  },
  renderHTML({ node }) {
    return [
      "img",
      {
        src: node.attrs.url,
        alt: node.attrs.source,
        title: node.attrs.source,
        "data-composer-emoji": "",
        draggable: "false",
      },
    ];
  },
  renderText({ node }) {
    return String(node.attrs.source);
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(value: string): void },
          node: { attrs: Record<string, unknown> },
        ) {
          state.write(String(node.attrs.source));
        },
      },
    };
  },
});
