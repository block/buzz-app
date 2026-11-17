import { useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { Button } from "../../shared/design-system/ui/Button";
import { savePersonalPull } from "./personal-pull";
import { useSoloPull } from "./SoloPull";
import type { SoloPulls } from "./solo-pull";
import styles from "./GitHub.module.css";

type Props = {
  relay: RelayData;
  pullsFor(session: RelaySession): SoloPulls;
  channelId: string;
};

/** Personal overlay actions never need the channel's shared-write authority. */
export function PersonalPullLink({
  relay,
  pullsFor,
  channelId,
  url,
}: Props & { url: string }) {
  const connection = useSyncExternalStore(relay.subscribe, relay.snapshot);
  return connection.status === "ready" && !connection.cached ? (
    <PersonalLink
      key={connection.generation}
      session={connection.session}
      pulls={pullsFor(connection.session)}
      channelId={channelId}
      url={url}
      active={() => {
        const now = relay.snapshot();
        return (
          now.status === "ready" &&
          !now.cached &&
          now.session === connection.session
        );
      }}
    />
  ) : null;
}

function PersonalLink({
  session,
  pulls,
  channelId,
  url,
  active,
}: {
  session: RelaySession;
  pulls: SoloPulls;
  channelId: string;
  url: string;
  active(): boolean;
}) {
  const channels = useChannelList(session.channels);
  const linked = useSoloPull(pulls, channelId)?.url === url;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const allowed = () =>
    active() &&
    session.channels
      .list()
      .channels.some((channel) => channel.id === channelId);
  if (!channels.channels.some((channel) => channel.id === channelId))
    return null;
  return (
    <div className={styles.soloLink}>
      <span className={styles.pullActionNote}>
        For you on this device only. No channel message or shared metadata
        changes.
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(undefined);
          try {
            await savePersonalPull(session, channelId, linked ? null : url, {
              allowed,
            });
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        {linked ? "Hide for me" : "Show for me"}
      </Button>
      {error && (
        <p role="alert" className={styles.pullActionError}>
          {error}
        </p>
      )}
    </div>
  );
}
