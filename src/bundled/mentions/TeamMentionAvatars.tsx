import type { RelaySession } from "../../features/relay/session";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { Avatar } from "../../shared/design-system/ui/Avatar";

/** Decorative, bounded preview from already-loaded identity data. No profile reads. */
export function TeamMentionAvatars({
  session,
  recipients,
}: {
  session: RelaySession;
  recipients: readonly MentionRecipient[];
}) {
  const profiles = session.profiles.snapshot();
  const agents = session.agentChoices.snapshot().identities;
  return (
    <span
      data-team-avatars=""
      aria-hidden="true"
      className="flex items-center gap-1"
    >
      {recipients.slice(0, 4).map((person) => (
        <Avatar
          key={person.pubkey}
          alt=""
          fallback={person.name}
          src={session.media(
            profiles.get(person.pubkey)?.picture ??
              agents.find((agent) => agent.pubkey === person.pubkey)?.avatar ??
              "",
            "small",
          )}
          size="small"
          shape="squircle"
        />
      ))}
      {recipients.length > 4 && (
        <span className="text-caption text-subtle">
          +{recipients.length - 4}
        </span>
      )}
    </span>
  );
}
