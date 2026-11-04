import { useState, type DragEvent, type ReactNode } from "react";
import { HashArrowInIcon } from "../../shared/design-system/icons";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  ATTACHMENT_FORWARD_MIME,
  attachmentsFromForwardPayload,
  parseAttachmentForwardPayload,
} from "./attachment-forwarding";

type Notice = Readonly<{ text: string; error?: boolean }>;

function hasAttachmentForward(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes(ATTACHMENT_FORWARD_MIME);
}

export function AttachmentForwardDropTarget({
  channel,
  session,
  children,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  children: ReactNode;
}) {
  const disabled = channel.archived || channel.cached || channel.readOnly;
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  if (disabled) return <>{children}</>;
  const clear = () => setOver(false);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Native file-style drag and drop lands on the existing sidebar navigation row. */}
      <div
        className="relative"
        onDragEnter={(event) => {
          if (!hasAttachmentForward(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragOver={(event) => {
          if (!hasAttachmentForward(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next))
            return;
          clear();
        }}
        onDrop={(event) => {
          if (!hasAttachmentForward(event)) return;
          event.preventDefault();
          event.stopPropagation();
          clear();
          const payload = parseAttachmentForwardPayload(
            event.dataTransfer.getData(ATTACHMENT_FORWARD_MIME),
          );
          const source = payload
            ? attachmentsFromForwardPayload(
                payload,
                session.channels.window(payload.sourceChannelId).rows,
              )
            : undefined;
          if (!source) {
            setNotice({
              text: "Reload the source message before sending its attachment.",
              error: true,
            });
            return;
          }
          try {
            session.messages.resendAttachments(
              channel.id,
              source.source,
              source.attachments,
            );
            setNotice({ text: `Attachment sent to ${channel.name}` });
          } catch (error) {
            setNotice({
              text:
                error instanceof Error
                  ? error.message
                  : "Couldn’t send attachment.",
              error: true,
            });
          }
        }}
        data-attachment-forward-target={over || undefined}
      >
        {children}
        {over && (
          <span
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[var(--radius-row)] bg-[var(--affordance-panel-hover)] text-caption text-standard"
            aria-hidden="true"
          >
            <span className="inline-flex items-center gap-1 rounded-full bg-panel px-2 py-1 shadow-sm ring-1 ring-border-standard">
              <HashArrowInIcon size={14} />
              Send here
            </span>
          </span>
        )}
      </div>
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </>
  );
}
