// Message bodies, received and own, with every Markdown element and a plugin
// code block, for comparing computed styles before and after a change.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import { createRoot } from "react-dom/client";
import type { ConversationExtensions } from "../../src/features/conversation/contracts";
import { MessageMarkdown } from "../../src/features/messages/MessageMarkdown";
import styles from "../../src/features/messages/Messages.module.css";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const BODY = [
  "# One",
  "## Two",
  "### Three",
  "#### Four",
  "##### Five",
  "###### Six",
  "Text with `code` and [a link](https://example.com).",
  "- a\n  - b\n- c",
  "1. x\n2. y",
  "- [x] done",
  "> quote",
  "---",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "```\nplain\n```",
  "```Mermaid\ndrawn\n```",
].join("\n\n");

const none: never[] = [];
const empty = { snapshot: () => none, subscribe: () => () => {} };
const renderers = [
  {
    id: "diagram",
    key: "fixture/diagram",
    pluginId: "fixture",
    revision: "1",
    title: "Diagram",
    matches: (language: string) => language === "Mermaid",
    component: ({ code }: { code: string }) => <figure>{code}</figure>,
  },
];
const extensions = {
  tools: empty,
  inline: empty,
  codeBlocks: { snapshot: () => renderers, subscribe: empty.subscribe },
} as unknown as ConversationExtensions;

const params = new URLSearchParams(location.search);
document.documentElement.dataset.messageDensity =
  params.get("density") ?? "default";

function Body({
  content,
  largeEmoji,
}: {
  content: string;
  largeEmoji?: boolean;
}) {
  return (
    <MessageMarkdown
      row={{
        id: content,
        channelId: "channel",
        authorId: "author",
        content,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
        emoji: [],
      }}
      media={() => undefined}
      onOpenLink={() => false}
      extensions={extensions}
      largeEmoji={largeEmoji}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ToastProvider>
    <div style={{ width: 640, padding: 16 }}>
      {(["received", "own"] as const).map((side) => (
        <div
          key={side}
          data-side={side}
          className={styles.messageBubble}
          data-own={side === "own" || undefined}
        >
          <Body content={BODY} />
          <Body content="😀" largeEmoji />
        </div>
      ))}
    </div>
  </ToastProvider>,
);
