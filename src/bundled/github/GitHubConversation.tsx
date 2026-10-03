import { Collapsible } from "@base-ui/react/collapsible";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  useReducedMotion,
} from "motion/react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  conversationEvents,
  groupConversationEvents,
  useConversationSource,
  type ConversationEvent,
  type EventRun,
} from "./conversation";
import { MediaAttachment } from "../../features/messages/MediaAttachment";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  CaretDownIcon,
  CaretUpIcon,
  DotsThreeIcon,
  GitMergeIcon,
  ChatCircleIcon,
  CheckCircleIcon,
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
}: {
  message: ConversationMessage;
  url: string;
  label: string;
  kind?: "description" | "review" | "comment" | "merge";
  reviewState?: string | undefined;
  fallback?: string;
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
  const canFitOnOneLine = textBody && !preview.images.length;
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
    kind === "merge"
      ? GitMergeIcon
      : kind === "review"
        ? reviewState === "APPROVED"
          ? CheckCircleIcon
          : reviewState === "CHANGES_REQUESTED"
            ? XCircleIcon
            : reviewState === "DISMISSED"
              ? XIcon
              : ChatCircleIcon
        : ChatCircleIcon;
  const marker =
    kind === "description" ? (
      <Avatar src={message.authorAvatar} alt="" fallback={message.author} />
    ) : (
      <span
        className={styles.eventIcon}
        data-review-state={kind === "review" ? reviewState : undefined}
        data-merged={kind === "merge" || undefined}
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
      data-bodyless={!hasBody || undefined}
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
              {label}
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
          </Collapsible.Panel>
        )}
      </div>
    </Collapsible.Root>
  );
}

const reviewLabels: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Review comment",
  DISMISSED: "Review dismissed",
};

function EventMessage({
  event,
  url,
}: {
  event: ConversationEvent;
  url: string;
}) {
  return (
    <Message
      message={event.message}
      url={url}
      label={
        event.kind === "merge"
          ? "Merged"
          : event.kind === "review"
            ? (reviewLabels[event.message.state ?? ""] ?? "Reviewed")
            : "Comment"
      }
      kind={event.kind === "discussion" ? "comment" : event.kind}
      reviewState={event.message.state}
      fallback={event.kind === "discussion" ? "No message provided" : ""}
    />
  );
}

function HistoryEvents({
  run,
  url,
  id,
}: {
  run: EventRun;
  url: string;
  id: string;
}) {
  const present = useIsPresent();
  const instant = usePresenceData() === true;
  return (
    <motion.div
      id={id}
      className={styles.historyReveal}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={instant ? false : { height: 0, opacity: 0 }}
      animate={{
        height: "auto",
        opacity: 1,
        transitionEnd: { overflow: "visible" },
      }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={{
        duration: instant ? 0 : present ? 0.2 : 0.14,
        ease: [0.23, 1, 0.32, 1],
      }}
    >
      <div className={styles.commentRunEvents}>
        {run.events.map((event) => (
          <EventMessage key={event.key} event={event} url={url} />
        ))}
      </div>
    </motion.div>
  );
}

function History({ run, url }: { run: EventRun; url: string }) {
  const [open, setOpen] = useState(false);
  const [keyboardToggle, setKeyboardToggle] = useState(false);
  const reduceMotion = useReducedMotion();
  const id = useId();
  const label = run.events.every(
    (event) =>
      event.kind === "discussion" || event.message.state === "COMMENTED",
  )
    ? "comments"
    : run.events.length === 1
      ? "event"
      : "events";
  const authors = [
    ...new Set(
      run.events.map((event) => event.message.author || "Unknown author"),
    ),
  ].join(", ");
  return (
    <Collapsible.Root
      className={styles.commentRun}
      data-buzz-ui=""
      open={open}
      onOpenChange={setOpen}
    >
      <Collapsible.Trigger
        className={`buzz-accordion-trigger text-body-sm ${styles.commentRunTrigger}`}
        aria-label={`${open ? "Hide" : "Show"} ${run.events.length} earlier ${label}`}
        aria-controls={open ? id : undefined}
        onClick={(event) => setKeyboardToggle(event.detail === 0)}
      >
        <span className={styles.eventIcon} aria-hidden="true">
          {open ? (
            <CaretUpIcon size={20} />
          ) : (
            <DotsThreeIcon size={20} weight="bold" />
          )}
        </span>
        <span className={styles.commentRunSummary}>
          {open ? (
            <span>
              Hide earlier {label === "comments" ? "comments" : "events"}
            </span>
          ) : (
            <>
              {run.events.length} earlier {label} <span>· {authors}</span>
            </>
          )}
        </span>
      </Collapsible.Trigger>
      <AnimatePresence
        initial={false}
        custom={!!reduceMotion || keyboardToggle}
      >
        {open && <HistoryEvents key="events" run={run} url={url} id={id} />}
      </AnimatePresence>
    </Collapsible.Root>
  );
}

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
  const events = useMemo(
    () => conversationEvents(discussion.entries, reviews.entries, details),
    [discussion.entries, reviews.entries, details],
  );
  const incomplete = [discussion, reviews].some(
    (source) => source.loading || source.error || source.next,
  );
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
        {groupConversationEvents(events).map((event) =>
          event.kind === "history" ? (
            <History key={event.key} run={event} url={url} />
          ) : (
            <EventMessage key={event.key} event={event} url={url} />
          ),
        )}
      </div>
      {!events.length && !incomplete && (
        <p className={styles.conversationNotice}>
          No discussion comments or review summaries to show.
        </p>
      )}
      {incomplete ? (
        <div className={styles.conversationSources}>
          <p className={styles.conversationNotice}>
            Loaded conversation only · some sources are incomplete.
          </p>
          <SourceStatus label="Discussion" source={discussion} />
          <SourceStatus label="Reviews" source={reviews} />
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
