import { Node } from "@tiptap/core";

export const CUSTOM_EMOJI_NODE = "customEmoji";
export const CustomEmojiNode = Node.create<{ onError: (url: string) => void }>({
  name: CUSTOM_EMOJI_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addOptions() {
    return { onError: () => {} };
  },
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
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.contentEditable = "false";
      const image = document.createElement("img");
      image.alt = image.title = String(node.attrs.source);
      image.draggable = false;
      image.dataset.composerEmoji = "";
      const showSource = () => this.options.onError(String(node.attrs.url));
      image.addEventListener("error", showSource, { once: true });
      image.src = String(node.attrs.url);
      dom.append(image);
      return {
        dom,
        destroy: () => image.removeEventListener("error", showSource),
      };
    };
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
