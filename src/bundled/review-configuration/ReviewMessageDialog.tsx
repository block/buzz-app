import { useChannelList } from "../../features/relay/react";
import { reviewChannelMember } from "./access";
import {
  MarkdownDocument,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import {
  DOCUMENT_PROFILE,
  DOCUMENT_RENDER_CELLS,
} from "../../features/markdown/document-profile";
import { guardDocument } from "../../features/markdown/guard";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { JsonValue } from "../../features/navigation/targets";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadView } from "../../features/relay/threads";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

export type MessageRoute = { channel: string; message: string };
export function messageRoute(
  value: JsonValue | undefined,
): MessageRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Record<string, JsonValue>;
  if (
    typeof route.channel === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(route.channel) &&
    typeof route.message === "string" &&
    /^[0-9a-f]{64}$/.test(route.message)
  )
    return { channel: route.channel, message: route.message };
}

export function ReviewMessageDialog({
  session,
  target,
  onClose,
  finalFocus,
}: {
  session: RelaySession;
  target: MessageRoute;
  onClose(): void;
  finalFocus(): HTMLElement | null;
}) {
  const channels = useChannelList(session.channels);
  const channel = channels.channels.find((item) => item.id === target.channel);
  const readable =
    channels.status === "ready" &&
    !!channel &&
    reviewChannelMember(channel, session.viewer);
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState("");
  useEffect(() => {
    let owned: ThreadView | undefined;
    setError("");
    setView(undefined);
    if (!readable) {
      setError("This review channel is unavailable.");
      return;
    }
    try {
      owned = session.thread(target.channel, target.message, { exact: true });
      setView(owned);
      void owned.refresh();
    } catch {
      setError("This message is unavailable.");
    }
    return () => owned?.dispose();
  }, [session, target.channel, target.message, readable]);
  return (
    <Dialog
      open
      visit
      title="Full message"
      closeLabel="Close full message"
      size="wide"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      finalFocus={finalFocus}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {!readable ? (
        <p role="alert">This review channel is unavailable.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : view ? (
        <MessageBody view={view} id={target.message} />
      ) : (
        <p role="status">Loading message…</p>
      )}
    </Dialog>
  );
}

function MessageBody({ view, id }: { view: ThreadView; id: string }) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const message =
    snapshot.target?.id === id
      ? snapshot.target
      : snapshot.root?.id === id
        ? snapshot.root
        : undefined;
  if (
    snapshot.status === "error" ||
    snapshot.targetStatus === "error" ||
    snapshot.targetStatus === "unavailable"
  )
    return (
      <p role="alert">
        This message is unavailable. Close and reopen to retry.
      </p>
    );
  if (!message) return <p role="status">Loading message…</p>;
  const content = message.sourceContent ?? message.content;
  return (
    <div className="review-config-message">
      <time
        className="text-caption text-subtle"
        dateTime={new Date(message.createdAt * 1000).toISOString()}
      >
        {new Date(message.createdAt * 1000).toLocaleString()}
      </time>
      {guardDocument(content, DOCUMENT_PROFILE, {
        chars: 100_000,
        cells: DOCUMENT_RENDER_CELLS,
      }) ? (
        <MarkdownDocument
          content={content}
          profile={DOCUMENT_PROFILE}
          components={sharedComponents}
          scale="message"
        />
      ) : (
        <div className="review-config-instructions">{content}</div>
      )}
    </div>
  );
}
