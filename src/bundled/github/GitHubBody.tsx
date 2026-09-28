import { memo, useMemo, type ReactNode } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { MediaAttachment } from "../../features/messages/MediaAttachment";
import { AudioAttachment } from "../../features/messages/AudioAttachment";
import {
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  attachmentFor,
  attachmentMetadata,
  bodyUrl,
  inertHtml,
} from "./attachments";
import styles from "./GitHub.module.css";

function containsImage(node: NonNullable<ExtraProps["node"]>): boolean {
  return (
    node.tagName === "img" ||
    node.children.some(
      (child) => child.type === "element" && containsImage(child),
    )
  );
}

// Only image attributes become Markdown nodes; arbitrary HTML stays inert.
function githubImages() {
  return (tree: Root) => {
    const visit = (parent: { type: string; children: RootContent[] }) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === "html") {
          const images = [...inertHtml(node.value).querySelectorAll("img")].map(
            (image) => ({
              type: "image" as const,
              url: image.getAttribute("src") ?? "",
              alt: image.getAttribute("alt") ?? "",
            }),
          );
          if (!images.length) return [];
          return ["root", "blockquote", "listItem"].includes(parent.type)
            ? [{ type: "paragraph", children: images }]
            : images;
        }
        if ("children" in node) visit(node);
        return [node];
      });
    };
    visit(tree);
  };
}

export const GitHubBody = memo(function GitHubBody({
  body,
  bodyHtml,
  url,
}: {
  body: string;
  bodyHtml?: string | undefined;
  url: string;
}) {
  const bounded = useMemo(
    () => body.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(body).tooDeep,
    [body],
  );
  const metadata = useMemo(
    () => (bounded ? attachmentMetadata(bodyHtml) : new Map()),
    [bounded, bodyHtml],
  );
  if (!bounded) return <div className={styles.plainBody}>{body}</div>;

  const media = (
    source: string,
    label: ReactNode,
    image = false,
    description = "",
  ) => {
    const attachment = attachmentFor(source, metadata, image);
    const link = (
      <a href={source} target="_blank" rel="noreferrer">
        {label || attachment?.name || "Open attachment"}
      </a>
    );
    if (!attachment) return link;
    return (
      <div className={styles.attachment} key={source}>
        {attachment.kind === "audio" ? (
          <AudioAttachment attachment={attachment} source={source} />
        ) : (
          <MediaAttachment
            attachment={attachment}
            media={(value) => value}
            imageDescription={description}
            preload="metadata"
          />
        )}
        {link}
      </div>
    );
  };

  return (
    <div className={styles.body}>
      <Markdown
        remarkPlugins={[remarkGfm, githubImages]}
        urlTransform={(value) => bodyUrl(value, url) ?? ""}
        components={{
          // Players are block elements, including when embedded in prose.
          p: ({ children }) => (
            <div className={styles.paragraph}>{children}</div>
          ),
          a: ({ href, children, node }) => {
            if (!href) return <>{children}</>;
            if (node && containsImage(node))
              return (
                <div>
                  {children}
                  <a href={href} target="_blank" rel="noreferrer">
                    {href}
                  </a>
                </div>
              );
            return media(href, children);
          },
          img: ({ src, alt }) =>
            typeof src === "string" && src ? media(src, alt, true, alt) : alt,
          table: ({ children }) => (
            <div className={styles.tableScroll}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
});
