import { Collapsible } from "@base-ui/react/collapsible";
import {
  Children,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  conversationEvents,
  useConversationSource,
  type CodeThread,
} from "./conversation";
import { MediaAttachment } from "../../features/messages/MediaAttachment";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  CaretDownIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CodeIcon,
  XCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { GitHubBody } from "./GitHubBody";
import type { GitHubDetails } from "./data";
import { bodyPreview, isTextBody } from "./preview";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";

export type ConversationMessage = {
  author: string;
  authorUrl?: string | undefined;
  authorAvatar?: string | undefined;
  createdAt?: string | undefined;
  body: string;
  bodyHtml?: string | undefined;
};

function PostedTime({ value }: { value: string | undefined }) {
  return value ? (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {relativeTimestamp(Date.parse(value) / 1000)}
    </time>
  ) : (
    <span>Time unavailable</span>
  );
}

function Author({ message }: { message: ConversationMessage }) {
  return (
    <span className={styles.messageAuthor}>
      {message.authorUrl ? (
        <a
          className={inlineStyles.link}
          href={message.authorUrl}
          target="_blank"
          rel="noreferrer"
        >
          {message.author || "Unknown author"}
        </a>
      ) : (
        message.author || "Unknown author"
      )}
    </span>
  );
}

function Thumbnails({ images, label }: { images: string[]; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(images.length);
  useLayoutEffect(() => {
    const element = row.current;
    const tile = element?.firstElementChild;
    if (
      !element ||
      !(tile instanceof HTMLElement) ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const update = () => {
      if (!element.clientWidth) return; // A hidden open-message row keeps its last capacity.
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
      const width = tile.getBoundingClientRect().width;
      if (width > 0)
        setCapacity(
          Math.max(1, Math.floor((element.clientWidth + gap) / (width + gap))),
        );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(tile);
    update();
    return () => observer.disconnect();
  }, []);
  const visible = images.slice(0, capacity);
  const hidden = images.length - visible.length;
  return (
    <div className={styles.thumbnails} ref={row}>
      {visible.map((src, index) => (
        <div className={styles.thumbnail} key={src}>
          <MediaAttachment
            attachment={{
              url: src,
              kind: "image",
              dimensions: { width: 1, height: 1 },
            }}
            media={(source) => source}
            imageDescription={`Image ${index + 1} in ${label}`}
          />
          {index === visible.length - 1 && hidden > 0 && (
            <span className={styles.thumbnailCount}>+{hidden}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Message({
  message,
  url,
  label,
  kind = "comment",
  reviewState,
  fallback = "No message provided",
  children,
}: {
  message: ConversationMessage;
  url: string;
  label: string;
  kind?: "description" | "review" | "comment" | "code";
  reviewState?: string | undefined;
  fallback?: string;
  children?: ReactNode;
}) {
  const preview = useMemo(
    () => bodyPreview(message.body, message.bodyHtml, url),
    [message.body, message.bodyHtml, url],
  );
  const header = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fitsOnOneLine, setFitsOnOneLine] = useState(false);
  const textBody = useMemo(
    () => isTextBody(message.body, message.bodyHtml, url),
    [message.body, message.bodyHtml, url],
  );
  const hasBody = !!message.body.trim() || !!fallback;
  const canFitOnOneLine =
    textBody && !preview.images.length && !Children.toArray(children).length;
  useLayoutEffect(() => {
    const content = header.current;
    const probe = measure.current;
    if (
      !content ||
      !probe ||
      !canFitOnOneLine ||
      !hasBody ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const update = () => {
      const lines: DOMRect[] = [];
      const walker = document.createTreeWalker(
        probe,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          lines.push(
            ...Array.from(range.getClientRects()).filter(
              (rect) => rect.width > 0,
            ),
          );
        } else if (node instanceof HTMLBRElement) {
          const range = document.createRange();
          range.selectNode(node);
          lines.push(...range.getClientRects());
        }
      }
      // Inline formatting has different glyph boxes; boxes on one line still overlap vertically.
      setFitsOnOneLine(
        content.clientWidth > 0 &&
          lines.length > 0 &&
          Math.max(...lines.map((line) => line.top)) <
            Math.min(...lines.map((line) => line.bottom)),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(content);
    observer.observe(probe);
    update();
    return () => observer.disconnect();
  }, [canFitOnOneLine, hasBody]);
  const expandable = !canFitOnOneLine || (hasBody && !fitsOnOneLine);
  const MarkerIcon =
    kind === "review"
      ? reviewState === "APPROVED"
        ? CheckCircleIcon
        : reviewState === "CHANGES_REQUESTED"
          ? XCircleIcon
          : reviewState === "DISMISSED"
            ? XIcon
            : ChatCircleIcon
      : kind === "code"
        ? CodeIcon
        : ChatCircleIcon;
  const marker =
    kind === "description" ? (
      <Avatar src={message.authorAvatar} alt="" fallback={message.author} />
    ) : (
      <span
        className={styles.eventIcon}
        data-review-state={kind === "review" ? reviewState : undefined}
      >
        <MarkerIcon size={20} aria-hidden="true" />
      </span>
    );
  return (
    <Collapsible.Root
      className={styles.conversationMessage}
      data-buzz-ui=""
      role="group"
      aria-label={label}
    >
      <div className={styles.messageMarker}>
        {expandable ? (
          <Collapsible.Trigger
            render={
              <IconButton
                variant="avatar"
                size="sm"
                aria-label={`Toggle ${label}`}
                icon={marker}
              />
            }
          />
        ) : (
          <span aria-hidden="true">{marker}</span>
        )}
      </div>
      <div className={styles.messageContent}>
        <div className={styles.messageHeader} ref={header}>
          {canFitOnOneLine && hasBody && (
            <div className={styles.messageMeasure} aria-hidden="true" inert>
              <div
                ref={measure}
                className={`text-body-sm ${styles.messageMeasureText}`}
              >
                {message.body ? (
                  <GitHubBody
                    body={message.body}
                    bodyHtml={message.bodyHtml}
                    url={url}
                  />
                ) : (
                  fallback
                )}
              </div>
            </div>
          )}
          {expandable && (
            <Collapsible.Trigger
              className={`buzz-accordion-trigger text-body-sm ${styles.messageTrigger}`}
              aria-label={`Expand ${label}`}
              title={
                message.createdAt
                  ? new Date(message.createdAt).toLocaleString()
                  : undefined
              }
            >
              <CaretDownIcon size={14} aria-hidden="true" />
            </Collapsible.Trigger>
          )}
          <div className={styles.messageMetadata}>
            <Author message={message} />
            <span
              className={styles.messageLabel}
              title={
                kind === "review"
                  ? "Submitted review event, not the PR’s current approval status"
                  : undefined
              }
            >
              {kind === "code" ? "Code comment" : label}
            </span>
            <span className={styles.messageTime}>
              <PostedTime value={message.createdAt} />
            </span>
          </div>
          {expandable ? (
            <span className={`text-body-sm ${styles.previewText}`}>
              {preview.text || fallback}
            </span>
          ) : hasBody ? (
            <div className={`text-body-sm ${styles.messageBody}`}>
              {message.body ? (
                <GitHubBody
                  body={message.body}
                  bodyHtml={message.bodyHtml}
                  url={url}
                />
              ) : (
                <p>{fallback}</p>
              )}
            </div>
          ) : null}
        </div>
        {!!preview.images.length && (
          <Thumbnails images={preview.images} label={label} />
        )}
        {expandable && (
          <Collapsible.Panel className={`text-body-sm ${styles.messageBody}`}>
            {message.body ? (
              <GitHubBody
                body={message.body}
                bodyHtml={message.bodyHtml}
                url={url}
              />
            ) : (
              <p>{fallback}</p>
            )}
            {children}
          </Collapsible.Panel>
        )}
      </div>
    </Collapsible.Root>
  );
}

function Thread({ thread, url }: { thread: CodeThread; url: string }) {
  const { root } = thread;
  return (
    <Accordion
      items={[
        {
          value: String(thread.id),
          title: (
            <span className={styles.threadLabel}>
              {root.path || "Code thread"}
              {root.line ? `:${root.line}` : ""} · {thread.replies.length + 1}{" "}
              loaded {thread.replies.length ? "comments" : "comment"}
            </span>
          ),
          content: (
            <>
              {thread.missingRoot && (
                <p className={styles.conversationNotice}>
                  Earlier context is unavailable in the loaded comments.
                </p>
              )}
              {root.diff && (
                <pre className={styles.codeContext}>{root.diff}</pre>
              )}
              {[root, ...thread.replies].map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  url={url}
                  kind="code"
                  label={`Code comment by ${message.author || "unknown author"}`}
                />
              ))}
            </>
          ),
        },
      ]}
    />
  );
}

const reviewLabels: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Reviewed",
  DISMISSED: "Review dismissed",
};

function SourceStatus({
  label,
  source,
}: {
  label: string;
  source: ReturnType<typeof useConversationSource>;
}) {
  if (!source.loading && !source.error && !source.next) return null;
  return (
    <section className={styles.sourceStatus} aria-label={label}>
      <span>
        {label} · {source.entries.length} loaded
      </span>
      {source.loading ? (
        <span role="status">Loading {label.toLowerCase()}…</span>
      ) : source.error ? (
        <>
          <span role="alert">{source.error}</span>
          <Button size="xs" onClick={source.retry}>
            Retry {label.toLowerCase()}
          </Button>
        </>
      ) : source.next ? (
        <Button size="xs" onClick={source.loadMore}>
          Load more {label.toLowerCase()}
        </Button>
      ) : null}
    </section>
  );
}

function Conversation({
  details,
  url,
}: {
  details: GitHubDetails;
  url: string;
}) {
  const discussion = useConversationSource(url, "discussion");
  const reviews = useConversationSource(url, "reviews");
  const inline = useConversationSource(url, "inline");
  const events = useMemo(
    () =>
      conversationEvents(discussion.entries, reviews.entries, inline.entries),
    [discussion.entries, reviews.entries, inline.entries],
  );
  const incomplete = [discussion, reviews, inline].some(
    (source) => source.loading || source.error || source.next,
  );
  const incompleteThreads = inline.loading || inline.error || inline.next;
  return (
    <section
      className={styles.conversation}
      aria-label="Pull request conversation"
    >
      <div className={styles.conversationTimeline}>
        <Message
          message={details}
          url={url}
          label="Description"
          kind="description"
          fallback="No description provided"
        />
        {events.map((event) =>
          event.kind === "thread" ? (
            <div className={styles.conversationMessage} key={event.key}>
              <span className={styles.eventIcon} aria-hidden="true">
                <CodeIcon size={20} />
              </span>
              <div className={styles.messageContent}>
                {event.threads.map((thread) => (
                  <Thread key={thread.id} thread={thread} url={url} />
                ))}
              </div>
            </div>
          ) : (
            <Message
              key={event.key}
              message={event.message}
              url={url}
              label={
                event.kind === "review"
                  ? (reviewLabels[event.message.state ?? ""] ?? "Reviewed")
                  : "Comment"
              }
              kind={event.kind === "review" ? "review" : "comment"}
              reviewState={event.message.state}
              fallback={
                event.kind === "review"
                  ? event.threads.length
                    ? `${event.threads.length} loaded code ${event.threads.length === 1 ? "thread" : "threads"}`
                    : ""
                  : "No message provided"
              }
            >
              {event.kind === "review" && incompleteThreads && (
                <p className={styles.conversationNotice}>
                  Code threads may be incomplete.
                </p>
              )}
              {event.threads.map((thread) => (
                <Thread key={thread.id} thread={thread} url={url} />
              ))}
            </Message>
          ),
        )}
      </div>
      {!events.length && !incomplete && (
        <p className={styles.conversationNotice}>
          No comments or submitted reviews yet.
        </p>
      )}
      {incomplete ? (
        <div className={styles.conversationSources}>
          <p className={styles.conversationNotice}>
            Loaded conversation only · some sources are incomplete.
          </p>
          <SourceStatus label="Discussion" source={discussion} />
          <SourceStatus label="Reviews" source={reviews} />
          <SourceStatus label="Code comments" source={inline} />
        </div>
      ) : (
        <p className={styles.conversationNotice}>
          Conversation loaded · oldest first
        </p>
      )}
    </section>
  );
}

export function GitHubConversation(props: {
  details: GitHubDetails;
  url: string;
}) {
  return <Conversation key={props.url} {...props} />;
}
