import { mergeAttributes, Node } from "@tiptap/core";

export const RECIPIENT_NODE = "recipient";
const recipientMarker = (token: string) => `\uE000recipient:${token}\uE001`;

export const RecipientNode = Node.create({
  name: RECIPIENT_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      pubkey: { default: "" },
      name: { default: "" },
      token: { default: "" },
    };
  },

  // Deliberately no parseHTML rule: pasted HTML and identity links can never
  // create notification authority. The adapter inserts this node explicitly.
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-recipient-chip": "",
        "data-pubkey": undefined,
        "data-token": undefined,
      }),
      `@${String(HTMLAttributes.name ?? "")}`,
    ];
  },

  renderText({ node }) {
    return `@${String(node.attrs.name ?? "")}`;
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(text: string): void },
          node: { attrs: Record<string, unknown> },
        ) {
          state.write(recipientMarker(String(node.attrs.token ?? "")));
        },
      },
    };
  },
});
