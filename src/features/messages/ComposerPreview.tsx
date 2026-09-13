import type { ConversationExtensions } from "../conversation/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import { MessageMarkdown } from "./MessageMarkdown";
import type { MentionDraft } from "./mention-draft";
import { useReferenceDirectory } from "./ReferenceText";
import styles from "./ComposerPreview.module.css";

/** Display the draft through the sent-message renderer without navigation or reads
 * for hover cards. The composer still owns the exact text and selected recipients. */
export function ComposerPreview({
  draft,
  session,
  scope,
  channelId,
  extensions,
  emoji,
}: {
  draft: MentionDraft;
  session: RelaySession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
}) {
  const directory = useReferenceDirectory(session, draft.recipients.length > 0);
  const profiles = new Map(directory.profiles);
  for (const recipient of draft.recipients) {
    if (!profiles.has(recipient.pubkey))
      profiles.set(recipient.pubkey, { name: recipient.name });
  }
  return (
    <section className={styles.preview} aria-label="Draft preview">
      <span className={styles.label}>Preview</span>
      <div className={styles.content}>
        <MessageMarkdown
          row={{
            id: "draft-preview",
            authorId: "",
            createdAt: 0,
            channelId,
            content: draft.text,
            mentions: draft.recipients.map((recipient) => recipient.pubkey),
            emoji,
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          }}
          directory={directory}
          participantProfiles={profiles}
          session={session}
          scope={scope}
          extensions={extensions}
          media={session.media}
          onOpenLink={() => false}
          interactive={false}
        />
      </div>
    </section>
  );
}
