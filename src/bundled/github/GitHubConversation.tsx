import { Collapsible } from "@base-ui/react/collapsible";
import { useMemo, type ReactNode } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import {
  conversationEvents,
  useConversationSource,
  type CodeThread,
} from "./conversation";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { GitHubBody } from "./GitHubBody";
import type { GitHubDetails } from "./data";
import { bodyPreview } from "./preview";
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

function Message({
  message,
  url,
  label,
  featured = false,
  fallback = "No message provided",
  children,
}: {
  message: ConversationMessage;
  url: string;
  label: string;
  featured?: boolean;
  fallback?: string;
  children?: ReactNode;
}) {
  const preview = useMemo(
    () => bodyPreview(message.body, message.bodyHtml, url),
    [message.body, message.bodyHtml, url],
  );
  return (
    <Collapsible.Root
      className={`${styles.conversationMessage} ${featured ? styles.featuredMessage : styles.quietMessage}`}
      data-buzz-ui=""
      role="group"
      aria-label={label}
    >
      <div className={styles.messageAvatar}>
        <Avatar
          src={message.authorAvatar}
          alt=""
          fallback={message.author}
          size={featured ? "default" : "small"}
        />
      </div>
      <div className={styles.messageContent}>
        <div className={styles.messageMetadata}>
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
            <span>{message.author || "Unknown author"}</span>
          )}
          <span className={styles.messageLabel}>{label}</span>
          <PostedTime value={message.createdAt} />
        </div>
        <Collapsible.Trigger
          className="buzz-accordion-trigger text-body-sm"
          aria-label={`Expand ${label}`}
        >
          <span className={styles.messagePreview}>
            <span className={styles.previewText}>
              {preview.text || fallback}
            </span>
            {!!preview.images.length && (
              <span className={styles.thumbnails} aria-hidden="true">
                {preview.images.slice(0, 3).map((src, index) => (
                  <span className={styles.thumbnail} key={src}>
                    <img
                      src={src}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                    />
                    {index === 2 && preview.images.length > 3 && (
                      <span className={styles.thumbnailCount}>
                        +{preview.images.length - 3}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            )}
          </span>
          <CaretDownIcon size={14} aria-hidden="true" />
        </Collapsible.Trigger>
        <Collapsible.Panel className={styles.messageBody}>
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
      ) : (
        <span>All pages loaded</span>
      )}
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
      <Message
        message={details}
        url={url}
        label="Description"
        featured
        fallback="No description provided"
      />
      <p className={styles.conversationNotice}>
        {incomplete
          ? "Loaded conversation only · some sources are incomplete."
          : "Conversation · oldest first"}{" "}
        Reviews are submitted events, not the PR’s current approval status.
      </p>
      <div className={styles.conversationTimeline}>
        {events.map((event) =>
          event.kind === "thread" ? (
            <div className={styles.standaloneThread} key={event.key}>
              {event.threads.map((thread) => (
                <Thread key={thread.id} thread={thread} url={url} />
              ))}
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
              featured={event.kind === "review"}
              fallback={
                event.kind === "review"
                  ? `${reviewLabels[event.message.state ?? ""] ?? "Reviewed"} · ${event.threads.length} loaded code threads`
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
      <div className={styles.conversationSources}>
        <SourceStatus label="Discussion" source={discussion} />
        <SourceStatus label="Reviews" source={reviews} />
        <SourceStatus label="Code comments" source={inline} />
      </div>
    </section>
  );
}

export function GitHubConversation(props: {
  details: GitHubDetails;
  url: string;
}) {
  return <Conversation key={props.url} {...props} />;
}
