import { Collapsible } from "@base-ui/react/collapsible";
import { useMemo, type ReactNode } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  conversationEvents,
  useConversationSource,
  type CodeThread,
} from "./conversation";
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
  const hasMetadata = kind === "description" || kind === "review";
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
  return (
    <Collapsible.Root
      className={`${styles.conversationMessage} ${hasMetadata ? styles.messageWithMetadata : styles.quietMessage}`}
      data-buzz-ui=""
      role="group"
      aria-label={label}
    >
      <div className={styles.messageMarker}>
        <Collapsible.Trigger
          render={
            <IconButton
              variant="avatar"
              size="sm"
              aria-label={`Toggle ${label}`}
              icon={
                kind === "description" ? (
                  <Avatar
                    src={message.authorAvatar}
                    alt=""
                    fallback={message.author}
                  />
                ) : (
                  <span
                    className={styles.eventIcon}
                    data-review-state={
                      kind === "review" ? reviewState : undefined
                    }
                  >
                    <MarkerIcon size={20} aria-hidden="true" />
                  </span>
                )
              }
            />
          }
        />
      </div>
      <div className={styles.messageContent}>
        {hasMetadata ? (
          <div className={styles.messageMetadata}>
            <Author message={message} />
            <span
              className={styles.messageLabel}
              title={
                label === "Description"
                  ? undefined
                  : "Submitted review event, not the PR’s current approval status"
              }
            >
              {label}
            </span>
            <span className={styles.messageTime}>
              <PostedTime value={message.createdAt} />
            </span>
          </div>
        ) : (
          <div className={styles.messageMetadata}>
            <Author message={message} />
            <span className={styles.messageLabel}>
              {kind === "code" ? "Code comment" : "Comment"}
            </span>
          </div>
        )}
        <Collapsible.Trigger
          className={`buzz-accordion-trigger text-body-sm ${styles.messageTrigger}`}
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
        {!hasMetadata && (
          <span className={styles.messageTime}>
            <PostedTime value={message.createdAt} />
          </span>
        )}
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
