import { useState, type DragEvent } from "react";
import { HashArrowInIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  ATTACHMENT_FORWARD_MIME,
  attachmentsFromForwardPayload,
  parseAttachmentForwardPayload,
} from "./attachment-forwarding";

function hasAttachmentForward(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes(ATTACHMENT_FORWARD_MIME);
}

export function useAttachmentForwardDropTarget(
  channel: ChannelSummary,
  session: RelaySession,
) {
  const disabled = channel.archived || channel.cached || channel.readOnly;
  const [over, setOver] = useState(false);
  const notify = useToastNotification();
  const clear = () => setOver(false);
  return {
    props: {
      onDragEnter: (event: DragEvent<HTMLDivElement>) => {
        if (disabled || !hasAttachmentForward(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        if (disabled || !hasAttachmentForward(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        clear();
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        if (disabled || !hasAttachmentForward(event)) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
        const payload = parseAttachmentForwardPayload(
          event.dataTransfer.getData(ATTACHMENT_FORWARD_MIME),
        );
        void (async () => {
          let view: ReturnType<RelaySession["thread"]> | undefined;
          try {
            let source = payload
              ? attachmentsFromForwardPayload(
                  payload,
                  session.channels.window(payload.sourceChannelId).rows,
                )
              : undefined;
            if (!source && payload) {
              // The channel timeline excludes ordinary thread replies. Read the
              // exact reconciled target so edits and deletions stay authoritative.
              view = session.thread(
                payload.sourceChannelId,
                payload.sourceMessageId,
                { exact: true },
              );
              await view.refresh();
              const snapshot = view.snapshot();
              source =
                snapshot.targetStatus === "ready" && snapshot.target
                  ? attachmentsFromForwardPayload(payload, [snapshot.target])
                  : undefined;
            }
            if (!source)
              throw new Error(
                "Reload the source message before sending its attachment.",
              );
            session.messages.resendAttachments(
              channel.id,
              source.source,
              source.attachments,
            );
            notify(`Sending attachment to ${channel.name}`, "info");
          } catch (error) {
            notify(
              error instanceof Error
                ? error.message
                : "Couldn’t send attachment.",
              "error",
            );
          } finally {
            view?.dispose();
          }
        })();
      },
      "data-attachment-forward-target": over || undefined,
    },
    overlay:
      over && !disabled ? (
        <span
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[var(--radius-row)] bg-[var(--affordance-panel-hover)] text-caption text-standard"
          aria-hidden="true"
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-panel px-2 py-1 shadow-sm ring-1 ring-border-standard">
            <HashArrowInIcon size={14} />
            Send here
          </span>
        </span>
      ) : null,
  };
}
