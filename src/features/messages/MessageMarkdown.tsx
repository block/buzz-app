import type { AnchorHTMLAttributes, MouseEvent } from "react";
import Markdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ConversationExtensions } from "../conversation/contracts";
import { InlineText } from "../conversation/InlineText";
import type { ChannelMessage } from "../relay/contracts";
import styles from "./Messages.module.css";

const MAX_MARKDOWN_LENGTH = 100_000;

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

/** Offer only Markdown prose to inline plugins; links and code remain literal. */
function remarkInlineContent() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (
        parent.type === "link" ||
        parent.type === "linkReference" ||
        parent.type === "code" ||
        parent.type === "inlineCode" ||
        !parent.children
      )
        return;
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
            hProperties: { "data-inline-text": child.value },
          },
        };
      }
    };
    visit(tree);
  };
}

export function safeMessageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
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
}: {
  row: ChannelMessage;
  extensions?: ConversationExtensions | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
}) {
  if (row.content.length > MAX_MARKDOWN_LENGTH)
    return <div className={styles.plainText}>{row.content}</div>;

  const components: Components = {
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

  return (
    <div className={styles.text}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkInlineContent]}
        components={components}
        skipHtml
        urlTransform={transformUrl}
      >
        {row.content}
      </Markdown>
    </div>
  );
}
