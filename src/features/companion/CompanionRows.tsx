import { useState, type ReactNode } from "react";
import type { CompanionRow } from "./row";
import { profileActivityViewKey } from "../profiles/target";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ImageReviewStage } from "../messages/ImageReviewStage";
import { MessageRow } from "../messages/MessageRow";
import {
  MessageReactionControls,
  MessageReactions,
  type ReactionSession,
} from "../messages/MessageReactions";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import {
  CompanionManagementItems,
  type CompanionManagementActions,
  toMessage,
} from "./CompanionManagementItems";

/** Interactive capabilities a companion may add to its rows; without them the
 * rows show reactions read-only and offer only copy actions. */
export type CompanionRowCapabilities = {
  /** Reactions through a session whose operations run in main. */
  reactions?:
    | {
        session: ReactionSession;
        tools: ContributionReader<ComposerTool>;
        inline: ContributionReader<InlineRenderer>;
      }
    | undefined;
  /** The owner's persistence scope, for message links. */
  scope?: string | undefined;
  /** Reply to one message within the thread. */
  onReply?: ((messageId: string) => void) | undefined;
  /** Main-admitted message management, driven by each row's projected policy. */
  management?: CompanionManagementActions | undefined;
  /** Conversation timelines: a row's thread opens in this window. */
  onOpenThread?: ((rootId: string) => void) | undefined;
};

/** Projected rows in a companion window: the shared message renderer over
 * owner-supplied media sources, with failed-delivery recovery and an image
 * stage. Reading, sending and link routing stay with the caller. */
export function CompanionRows({
  rows,
  writable,
  openLink,
  recover,
  focusConversation,
  allowImageCopy = true,
  children,
  capabilities,
  layout = "thread",
}: {
  rows: readonly CompanionRow[];
  writable: boolean;
  /** A conversation timeline shows day dividers and thread affordances. */
  layout?: "thread" | "timeline";
  capabilities?: CompanionRowCapabilities | undefined;
  openLink?: ((target: string) => boolean) | undefined;
  recover(id: string, dismiss?: boolean): void;
  focusConversation(): void;
  allowImageCopy?: boolean;
  /** Rendered after the rows, inside the same list. */
  children?: ReactNode;
}) {
  const [image, setImage] = useState<{ rowId: string; url: string }>();
  const imageRow = rows.find((row) => row.id === image?.rowId);
  const selectedImage = imageRow?.attachments.find(
    (attachment) => attachment.url === image?.url,
  );
  return (
    <>
      {rows.map((row, index) => {
        // The row's own recovery line below reports delivery; the renderer's
        // would duplicate it.
        const { delivery: _delivery, ...message } = toMessage(row);
        const previous = rows[index - 1];
        const day =
          layout === "timeline" &&
          (!previous ||
            new Date(previous.time * 1000).toDateString() !==
              new Date(row.time * 1000).toDateString());
        const openThread = capabilities?.onOpenThread;
        const management = capabilities?.management;
        const reactions = capabilities?.reactions;
        const scope = capabilities?.scope;
        const interactive =
          reactions && scope && writable && row.delivery === "seen";
        return (
          <div key={row.id}>
            <MessageRow
              row={message}
              scope={scope}
              viewer={reactions?.session.viewer}
              onReply={
                capabilities?.onReply && writable
                  ? capabilities.onReply
                  : undefined
              }
              quickControls={
                interactive ? (
                  <MessageReactionControls
                    row={message}
                    session={reactions.session}
                    scope={scope}
                    tools={reactions.tools}
                    inline={reactions.inline}
                    disabled={false}
                  />
                ) : undefined
              }
              overflowItems={
                management && row.management ? (
                  <CompanionManagementItems row={row} actions={management} />
                ) : undefined
              }
              reactionSlot={
                reactions && scope ? (
                  <MessageReactions
                    row={message}
                    session={reactions.session}
                    scope={scope}
                    tools={reactions.tools}
                    inline={reactions.inline}
                    disabled={!interactive}
                  />
                ) : undefined
              }
              participantProfiles={
                new Map(
                  Object.entries(row.mentionNames ?? {}).map(([key, name]) => [
                    key,
                    { name },
                  ]),
                )
              }
              profile={{
                name: row.author,
                ...(row.pictureUrl ? { picture: row.pictureUrl } : {}),
              }}
              media={(url) => {
                if (url === row.pictureUrl) return row.picture ?? undefined;
                for (const attachment of row.attachments) {
                  if (url === attachment.url)
                    return attachment.source ?? undefined;
                  if (url === attachment.previewUrl)
                    return attachment.previewSource ?? undefined;
                }
                return undefined;
              }}
              canOpenLink={(url) =>
                row.attachments.some(
                  (attachment) =>
                    attachment.kind === "image" && attachment.url === url,
                ) ||
                // An agent's activity view opens in the main window.
                (!!openLink && !!profileActivityViewKey(url))
              }
              onOpenLink={(url) => {
                if (
                  !row.attachments.some(
                    (attachment) =>
                      attachment.kind === "image" && attachment.url === url,
                  )
                )
                  return openLink?.(url) ?? false;
                setImage({ rowId: row.id, url });
                return true;
              }}
              day={day}
              retry={undefined}
              layout={layout}
              onOpenThread={
                layout === "timeline" && openThread
                  ? (_messageId, threadRootId) => openThread(threadRootId)
                  : undefined
              }
              startsThreads={layout === "timeline" && !!openThread && writable}
            />
            {["failed", "unknown"].includes(row.delivery) && (
              <p role="status" className="text-secondary">
                {row.delivery === "unknown"
                  ? "Delivery hasn’t been confirmed. Retry sends the same message."
                  : "Message wasn’t delivered."}{" "}
                <Button
                  size="sm"
                  disabled={!writable}
                  onClick={() => {
                    focusConversation();
                    recover(row.id);
                  }}
                >
                  Retry
                </Button>{" "}
                <Button
                  size="sm"
                  onClick={() => {
                    focusConversation();
                    recover(row.id, true);
                  }}
                >
                  Discard
                </Button>
              </p>
            )}
          </div>
        );
      })}
      {children}
      <Dialog
        open={!!selectedImage}
        onOpenChange={(open) => {
          if (!open) setImage(undefined);
        }}
        title={selectedImage?.name ?? "Image attachment"}
        size="expanded"
        height="stable"
        bodyLayout="flex"
      >
        {imageRow && selectedImage && (
          <ImageReviewStage
            allowCopy={allowImageCopy}
            attachments={imageRow.attachments.filter(
              (attachment) => attachment.kind === "image",
            )}
            selectedUrl={selectedImage.url}
            media={(url) =>
              imageRow.attachments.find((attachment) => attachment.url === url)
                ?.source ?? undefined
            }
            select={(url) => setImage({ rowId: imageRow.id, url })}
            onOpenLink={() => false}
          />
        )}
      </Dialog>
    </>
  );
}
