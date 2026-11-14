import { useMemo } from "react";
import { MessageRow } from "../features/messages/MessageRow";
import type { ChannelMessage } from "../features/relay/contracts";
import type { MessageDensity, MessageWidth } from "../shared/theme/service";
import { useLocalDay } from "../shared/use-local-day";
import styles from "./AppearancePreview.module.css";

const VIEWER = "preview-viewer";
const message = (
  id: string,
  authorId: string,
  createdAt: number,
  content: string,
): ChannelMessage => ({
  id,
  channelId: "appearance-preview",
  authorId,
  createdAt,
  content,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});
/** Dated today at 9:41 local time, so bylines show a clock readable in either
 * hour cycle rather than a past date. */
const sampleConversation = (today: Date) => {
  const at = (minute: number) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      9,
      minute,
    ).getTime() / 1000;
  return [
    {
      row: message(
        "teammate-1",
        "preview-teammate",
        at(41),
        "Morning! The [release notes](https://example.org/release-notes) are ready for a look.",
      ),
      profile: { name: "Ari" },
      stackPrevious: false,
      stackNext: true,
    },
    {
      row: message(
        "teammate-2",
        "preview-teammate",
        at(42),
        "Could you skim them before standup?",
      ),
      profile: { name: "Ari" },
      stackPrevious: true,
      stackNext: false,
    },
    {
      row: message("viewer-1", VIEWER, at(44), "On it. Comments by 10."),
      profile: { name: "You" },
      stackPrevious: false,
      stackNext: false,
    },
  ];
};
const noMedia = () => undefined;
const noLink = () => false;

/** A sample conversation drawn by the live message rows, so it follows every
 * appearance and conversation preference as the timeline does. */
export function AppearancePreview({
  messageWidth,
  density,
  embedded = false,
}: {
  messageWidth: MessageWidth;
  density: MessageDensity;
  /** Join the preview to the related preference group. */
  embedded?: boolean;
}) {
  const day = useLocalDay();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-date the sample at local midnight and keep its rows memoized between.
  const sample = useMemo(() => sampleConversation(new Date()), [day]);
  const effectiveWidth = density === "compact" ? "wide" : messageWidth;
  return (
    <figure
      className={styles.preview}
      data-embedded={embedded || undefined}
      aria-label="Appearance preview"
    >
      <div
        className={styles.conversation}
        data-message-width={effectiveWidth}
        inert
        aria-hidden="true"
      >
        {sample.map(({ row, ...props }) => (
          <MessageRow
            key={row.id}
            row={row}
            {...props}
            viewer={VIEWER}
            media={noMedia}
            onOpenLink={noLink}
            day={false}
            retry={undefined}
          />
        ))}
      </div>
      <figcaption className="sr-only">
        Sample conversation in{" "}
        {density === "compact"
          ? "Compact density, as a flat list across the full width."
          : `Default density, as bubbles at ${messageWidth} width.`}
      </figcaption>
    </figure>
  );
}
