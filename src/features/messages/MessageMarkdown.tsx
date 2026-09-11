import type { AnchorHTMLAttributes, MouseEvent } from "react";
import Markdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ConversationExtensions } from "../conversation/contracts";
import { InlineText } from "../conversation/InlineText";
import type { ChannelMessage } from "../relay/contracts";
import { emojiMatches, messageParts } from "../relay/emoji";
import {
  markdownIsSafeToRender,
  safeMessageUrl,
} from "../relay/message-content";
import styles from "./Messages.module.css";

// Private-use sentinels preserve recognized token boundaries through emphasis parsing.
const EMOJI_PLACEHOLDER_START = "\u{E000}";
const EMOJI_PLACEHOLDER_END = "\u{E001}";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

function protectCustomEmoji(row: ChannelMessage): {
  content: string;
  shortcodes: string[];
} {
  const shortcodes: string[] = [];
  const content = messageParts(row.content)
    .map((part) => {
      if (part.startsWith("https://")) return part;
      let result = "";
      let offset = 0;
      for (const match of emojiMatches(part, row.emoji ?? [])) {
        result += part.slice(offset, match.start);
        shortcodes.push(`:${match.emoji.shortcode}:`);
        result += `${EMOJI_PLACEHOLDER_START}${shortcodes.length - 1}${EMOJI_PLACEHOLDER_END}`;
        offset = match.end;
      }
      return result + part.slice(offset);
    })
    .join("");
  return { content, shortcodes };
}

const placeholderPattern = () =>
  new RegExp(`${EMOJI_PLACEHOLDER_START}(\\d+)${EMOJI_PLACEHOLDER_END}`, "g");
function restoreEmoji(value: string, shortcodes: readonly string[]): string {
  return value.replace(placeholderPattern(), (_match, index: string) => {
    return shortcodes[Number(index)] ?? "";
  });
}

/** Offer only Markdown prose to inline plugins; links and code remain literal. */
function remarkInlineContent(shortcodes: readonly string[] = []) {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (parent.type === "code" || parent.type === "inlineCode") {
        if (typeof parent.value === "string")
          parent.value = restoreEmoji(parent.value, shortcodes);
        return;
      }
      if (parent.type === "link" || parent.type === "linkReference") {
        const pending = [...(parent.children ?? [])];
        while (pending.length) {
          const child = pending.pop();
          if (!child) continue;
          if (typeof child.value === "string")
            child.value = restoreEmoji(child.value, shortcodes);
          pending.push(...(child.children ?? []));
        }
        return;
      }
      if (!parent.children) return;
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (!child) continue;
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          continue;
        }
        parent.children[index] = {
          type: "buzzInlineContent",
          data: {
            hName: "span",
            hProperties: {
              "data-inline-text": restoreEmoji(child.value, shortcodes),
            },
          },
        };
      }
    };
    visit(tree);
  };
}

const transformUrl: UrlTransform = (value) => safeMessageUrl(value);

function MessageLink({
  href,
  onOpenLink,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  onOpenLink(url: string): boolean;
}) {
  const url = href ? safeMessageUrl(href) : undefined;
  if (!url) return <span>{children}</span>;
  return (
    <a
      {...props}
      href={url}
      title={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          onOpenLink(url)
        )
          event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

export function MessageMarkdown({
  row,
  extensions,
  media,
  onOpenLink,
  largeEmoji = false,
}: {
  row: ChannelMessage;
  extensions?: ConversationExtensions | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  largeEmoji?: boolean | undefined;
}) {
  if (!markdownIsSafeToRender(row.content))
    return <div className={styles.plainText}>{row.content}</div>;

  const protectedEmoji = protectCustomEmoji(row);
  const components: Components = {
    p: ({ node: _node, ...props }) => (
      <p
        {...props}
        className={largeEmoji ? styles.text : undefined}
        data-single-emoji={largeEmoji || undefined}
      />
    ),
    a: ({ node: _node, ...props }) => (
      <MessageLink {...props} onOpenLink={onOpenLink} />
    ),
    img: ({ node: _node, alt }) =>
      alt ? <span className={styles.imageAlt}>{alt}</span> : null,
    span: ({ node: _node, children, ...props }) => {
      const text = (props as typeof props & { "data-inline-text"?: unknown })[
        "data-inline-text"
      ];
      return typeof text === "string" ? (
        extensions ? (
          <InlineText
            registry={extensions.inline}
            content={{ text, message: row }}
            media={media}
          />
        ) : (
          text
        )
      ) : (
        <span {...props}>{children}</span>
      );
    },
  };

  const markdown = (
    <Markdown
      remarkPlugins={[
        remarkGfm,
        remarkBreaks,
        [remarkInlineContent, protectedEmoji.shortcodes],
      ]}
      components={components}
      skipHtml
      urlTransform={transformUrl}
    >
      {protectedEmoji.content}
    </Markdown>
  );
  return largeEmoji ? markdown : <div className={styles.text}>{markdown}</div>;
}
