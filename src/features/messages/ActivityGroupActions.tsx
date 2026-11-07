import { useChannelIdentityNames } from "../identity-names/react";
import type { MessageLinkOrigin } from "./MessageRow";
import { useSyncExternalStore } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InfoIcon } from "../../shared/design-system/icons";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../profiles/target";
import type { RelaySession } from "../relay/session";
import type { Profile } from "../relay/contracts";
import type { ActivityPresentation } from "./activity-presentation";

const noSubscribe = () => () => {};

/** The visible history's way into its participants' transcripts. Stopping live
 * work belongs to the conversation's end indicator. */
export function ActivityGroupActions({
  session,
  group,
  profiles,
  open,
  canOpen,
  active,
}: {
  /** False while the history is collapsed. */
  active: boolean;
  session: RelaySession;
  group: ActivityPresentation;
  profiles: ReadonlyMap<string, Profile>;
  open?: ((target: string, origin?: MessageLinkOrigin) => boolean) | undefined;
  canOpen?: ((target: string) => boolean) | undefined;
}) {
  const choices = useSyncExternalStore(
    active ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, group.latest.channelId);
  const named = (agent: string) =>
    resolveName(
      agent,
      profiles.get(agent)?.name ??
        choices.identities.find((row) => row.pubkey === agent)?.name ??
        agent.slice(0, 10),
    );
  const { latest, participants } = group;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {participants.map((agent) => {
        const name = named(agent);
        const target = profileActivityViewTarget(agent);
        return target && open && canOpen?.(target) ? (
          <IconButton
            key={agent}
            size="sm"
            variant="subtle"
            aria-label={
              participants.length > 1 ? `${name} transcript` : "View transcript"
            }
            title={
              participants.length > 1 ? `${name} transcript` : "View transcript"
            }
            icon={<InfoIcon aria-hidden="true" />}
            onClick={() =>
              openProfileTranscript(target, (next) =>
                open(
                  next,
                  latest.threadRootId
                    ? { rootId: latest.threadRootId }
                    : undefined,
                ),
              )
            }
          />
        ) : null;
      })}
    </div>
  );
}
