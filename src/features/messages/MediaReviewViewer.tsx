import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ConversationExtensions } from "../conversation/contracts";
import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageComposer } from "./MessageComposer";
import { ImageReviewStage } from "./ImageReviewStage";
import { MessageRow } from "./MessageRow";
import { formatMediaTime } from "./media-timecode";
import styles from "./Messages.module.css";

type MediaReviewViewerProps = {
  attachment: Attachment;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  initialTime: number;
  close(): void;
};

export function MediaReviewViewer({
  attachment,
  extensions,
  session,
  scope,
  channelId,
  channelName,
  messageId,
  initialTime,
  close,
}: MediaReviewViewerProps) {
  const source = session.media(attachment.url) ?? attachment.url;
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [includeTime, setIncludeTime] = useState(true);
  const [view, setView] = useState<ThreadView>();
  const [threadError, setThreadError] = useState<string>();
  const [selectedImageUrl, setSelectedImageUrl] = useState(attachment.url);

  // Allocate owned session views in an effect so StrictMode cannot leak a reader.
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId);
      setThreadError(undefined);
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch (error) {
      setThreadError(String(error));
    }
  }, [session, channelId, messageId]);
  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [close]);

  const seek = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    void video.current.play().catch(() => {});
  };

  return createPortal(
    <div className={styles.mediaReviewBackdrop}>
      <section
        className={styles.mediaReviewViewer}
        role="dialog"
        aria-modal="true"
        aria-label={attachment.video ? "Video review" : "Image viewer"}
      >
        <header className={styles.mediaReviewHeading}>
          <span>{attachment.video ? "Video review" : "Image"}</span>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close fullscreen viewer"
            onClick={close}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.mediaReviewStage}>
          {attachment.video ? (
            // biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL.
            <video
              ref={video}
              src={source}
              controls
              autoPlay
              playsInline
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = initialTime;
              }}
              onTimeUpdate={(event) =>
                setCurrentTime(event.currentTarget.currentTime)
              }
            />
          ) : view ? (
            <ImageReviewGallery
              view={view}
              selectedUrl={selectedImageUrl}
              select={setSelectedImageUrl}
              media={session.media}
            />
          ) : (
            <img src={source} alt="Attachment preview" />
          )}
        </div>
        <aside className={styles.mediaReviewConversation}>
          {threadError ? (
            <p className={styles.empty} role="alert">
              {threadError}
            </p>
          ) : view ? (
            <ReviewComments
              view={view}
              session={session}
              extensions={extensions}
              {...(attachment.video ? { seek } : {})}
            />
          ) : (
            <p className={styles.empty} role="status">
              Loading comments…
            </p>
          )}
          {attachment.video && (
            <div className={styles.mediaReviewTimeOption}>
              <span>{formatMediaTime(currentTime)}</span>
              <label>
                <input
                  type="checkbox"
                  checked={includeTime}
                  onChange={(event) =>
                    setIncludeTime(event.currentTarget.checked)
                  }
                />
                Comment at current frame
              </label>
            </div>
          )}
          <MessageComposer
            extensions={extensions}
            session={session}
            scope={scope}
            channelId={channelId}
            channelName={channelName}
            threadRootId={messageId}
            {...(attachment.video && includeTime
              ? { mediaTimeSeconds: currentTime }
              : {})}
            hideMediaTimeIndicator
          />
        </aside>
      </section>
    </div>,
    document.body,
  );
}

function ImageReviewGallery({
  view,
  selectedUrl,
  select,
  media,
}: {
  view: ThreadView;
  selectedUrl: string;
  select(url: string): void;
  media(url: string): string | undefined;
}) {
  const thread = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const attachments = useMemo(() => {
    const seen = new Set<string>();
    return [thread.root, ...thread.replies]
      .flatMap((row) => row?.attachments ?? [])
      .filter((item) => {
        if (item.video || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
  }, [thread.root, thread.replies]);
  return (
    <ImageReviewStage
      attachments={
        attachments.some((item) => item.url === selectedUrl)
          ? attachments
          : [{ url: selectedUrl, video: false }, ...attachments]
      }
      selectedUrl={selectedUrl}
      media={media}
      select={select}
    />
  );
}

function ReviewComments({
  view,
  session,
  extensions,
  seek,
}: {
  view: ThreadView;
  session: RelaySession;
  extensions?: ConversationExtensions | undefined;
  seek?: (seconds: number) => void;
}) {
  const thread = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const rows = useMemo(
    () => (thread.root ? [thread.root, ...thread.replies] : thread.replies),
    [thread.root, thread.replies],
  );
  const profiles = useRowProfiles(session.profiles, rows);
  const authors = [...new Set(rows.map((row) => row.authorId))]
    .sort()
    .join(":");
  useEffect(() => {
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors]);
  useEffect(() => {
    if (thread.status === "ready" && thread.canLoadMore) void view.loadMore();
  }, [view, thread.status, thread.canLoadMore]);

  return (
    <section className={styles.mediaReviewThread} aria-label="Media comments">
      <div className={styles.mediaReviewThreadHeading}>
        <strong>Comments</strong>
        <span>{thread.replies.length}</span>
      </div>
      {thread.replies.map((row) => (
        <MessageRow
          key={row.id}
          row={row}
          extensions={extensions}
          profile={profiles.get(row.authorId)}
          media={session.media}
          onOpenLink={() => false}
          day={false}
          retry={session.messages.retry}
          {...(seek ? { onMediaTime: seek } : {})}
        />
      ))}
      {(thread.status === "loading" ||
        (thread.status === "ready" && thread.canLoadMore)) && (
        <p role="status">Loading comments…</p>
      )}
      {thread.error && <p role="alert">{thread.error}</p>}
      {thread.status === "ready" && thread.replies.length === 0 && (
        <p className={styles.threadNote}>No comments yet.</p>
      )}
    </section>
  );
}
