import { useState, type ReactNode } from "react";
import type { CompanionRow } from "./row";
import { profileActivityViewKey } from "../profiles/target";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ImageReviewStage } from "../messages/ImageReviewStage";
import { MessageRow } from "../messages/MessageRow";
import { MembershipRow } from "../messages/MembershipRow";
import { membershipRows, type TimelineRow } from "../messages/membership-rows";
import {
  MessageReactionControls,
  MessageReactions,
  type ReactionSession,
} from "../messages/MessageReactions";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
  LinkRenderer,
} from "../conversation/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import {
  CompanionManagementItems,
  type CompanionManagementActions,
  toMessage,
} from "./CompanionManagementItems";
import { CompanionWorking } from "./CompanionWorking";
import type { StopOutcome } from "../popout/thread";

/** Interactive capabilities a companion may add to its rows; without them the
 * rows show reactions read-only and offer only copy actions. */
export type CompanionRowCapabilities = {
  /** Reactions through a session whose operations run in main. */
  reactions?:
    | {
        session: ReactionSession;
        tools: ContributionReader<ComposerTool>;
        inline: ContributionReader<InlineRenderer>;
        /** Link renderers main has enabled, so links label as they do there. */
        links?: ContributionReader<LinkRenderer> | undefined;
      }
    | undefined;
  /** The owner's persistence scope, for message links. */
  scope?: string | undefined;
  /** Reply to one message within the thread. */
  onReply?: ((messageId: string) => void) | undefined;
  /** Main-admitted message management, driven by each row's projected policy. */
  management?: CompanionManagementActions | undefined;
  /** Conversation timelines: a row's thread opens in this window; `reply`
   * also focuses its composer, as main's Reply does from a channel. */
  onOpenThread?: ((rootId: string, intent?: "reply") => void) | undefined;
  /** Stop an agent's live work on a shown request, admitted in main. */
  stopWork?: ((key: string) => Promise<StopOutcome>) | undefined;
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
  // A timeline groups consecutive membership rows into one notice, as main's
  // does; the group takes the id of its newest row.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const grouped =
    layout === "timeline"
      ? membershipRows(rows.map((row) => toMessage(row)))
      : rows.map((row) => toMessage(row) as TimelineRow);
  const membershipProfiles = (row: TimelineRow) =>
    new Map(
      (row.membershipRows ?? [row]).flatMap((entry) =>
        [entry.membership?.actor, entry.membership?.target].flatMap((key) => {
          const name = key && byId.get(entry.id)?.mentionNames?.[key];
          return key && name ? [[key, { name }] as const] : [];
        }),
      ),
    );
  return (
    <>
      {grouped.map((timelineRow, index) => {
        const row = byId.get(timelineRow.id);
        if (!row) return null;
        const previous = grouped[index - 1];
        const day =
          layout === "timeline" &&
          (!previous ||
            new Date(previous.createdAt * 1000).toDateString() !==
              new Date(timelineRow.createdAt * 1000).toDateString());
        if (timelineRow.membership)
          return (
            <MembershipRow
              key={row.id}
              row={timelineRow}
              profiles={membershipProfiles(timelineRow)}
              viewer={capabilities?.reactions?.session.viewer}
              media={() => undefined}
              day={day}
            />
          );
        // The row's own recovery line below reports delivery; the renderer's
        // would duplicate it.
        const { delivery: _delivery, ...message } = toMessage(row);
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
              // The bridge session carries main's channel list and profiles:
              // channel links and Solo chips label as in main. Message
              // links take main's projected labels (`linkLabels`); the
              // companion never reads a linked message itself.
              references={reactions?.session}
              extensions={
                reactions
                  ? {
                      tools: reactions.tools,
                      inline: reactions.inline,
                      ...(reactions.links ? { links: reactions.links } : {}),
                    }
                  : undefined
              }
              linkLabels={
                row.linkLabels
                  ? new Map(Object.entries(row.linkLabels))
                  : undefined
              }
              scope={scope}
              viewer={reactions?.session.viewer}
              // A thread window replies in place; a conversation window's
              // Reply opens the thread, as main's channel view does.
              onReply={
                layout !== "timeline" && capabilities?.onReply && writable
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
                  ? (_messageId, threadRootId, intent) =>
                      openThread(threadRootId, intent)
                  : undefined
              }
              startsThreads={layout === "timeline" && !!openThread && writable}
            />
            {row.live && row.live.length > 0 && capabilities?.stopWork && (
              // Main's live bubble under a request: its agents' current step,
              // status and Stop, as the row shows them there.
              <CompanionWorking
                working={row.live}
                layout={layout === "timeline" ? "timeline" : "thread"}
                stop={capabilities.stopWork}
                openActivity={openLink}
              />
            )}
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
