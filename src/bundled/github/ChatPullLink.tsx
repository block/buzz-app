import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useOptionalConversation } from "../../features/conversation/Conversation";
import { useConversationPresentation } from "../../features/conversation/ConversationPresentation";
import {
  LinkPreviewContext,
  type LinkPreview,
} from "../../features/conversation/LinkLabelContext";
import { fullSession } from "../../features/messages/composer-session";
import { useListedChannel } from "../../features/relay/listed-channel";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ownSolo } from "../../features/solo/labels";
import { LinkBreakIcon, LinkIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { GitHubLink } from "./GitHubLink";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";
import { useSoloPull } from "./SoloPull";
import { writeLink, type SoloPulls } from "./solo-pull";
import styles from "./GitHub.module.css";

/** A supplemental action in the host's hover card, independent of link opening. */
export function ChatPullLink({
  url,
  states,
  relay,
  pullsFor,
}: {
  url: string;
  states: PullStates;
  relay: RelayData;
  pullsFor(session: RelaySession): SoloPulls;
}) {
  const conversation = useOptionalConversation();
  const offer = useContext(LinkPreviewContext);
  const active = useConversationPresentation();
  const session = fullSession(conversation?.session);
  const channelId = conversation?.channelId;
  const scope = conversation?.scope;
  const eligible = useListedChannel(
    session?.channels,
    channelId,
    (channel) =>
      ownSolo(channel, session?.viewer) &&
      !channel?.archived &&
      !channel?.readOnly,
  );
  const reference = parseGitHubReference(url, { pullSubtargets: true });
  const pullUrl = reference?.kind === "pull" ? reference.url : undefined;
  return (
    <>
      <GitHubLink url={url} states={states} />
      {offer &&
        active &&
        eligible &&
        session &&
        channelId &&
        scope &&
        pullUrl && (
          <ChatPullPreview
            key={`${scope}:${channelId}:${pullUrl}`}
            offer={offer}
            relay={relay}
            session={session}
            scope={scope}
            channelId={channelId}
            url={pullUrl}
            pulls={pullsFor(session)}
          />
        )}
    </>
  );
}

export function ChatPullPreview({
  offer,
  relay,
  session,
  scope,
  channelId,
  url,
  pulls,
}: {
  offer(preview: LinkPreview | undefined): void;
  relay: RelayData;
  session: RelaySession;
  scope: string;
  channelId: string;
  url: string;
  pulls: SoloPulls;
}) {
  const connection = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const active = useConversationPresentation();
  const eligible = useListedChannel(
    session.channels,
    channelId,
    (channel) =>
      ownSolo(channel, session.viewer) &&
      !channel?.archived &&
      !channel?.readOnly,
  );
  const linked = useSoloPull(pulls, channelId)?.url === url;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const writable =
    active &&
    eligible &&
    connection.status === "ready" &&
    !connection.cached &&
    connection.session === session &&
    connection.scope === scope &&
    !!session.configArtifactWriter &&
    !!session.snapshotRead;
  const Icon = linked ? LinkBreakIcon : LinkIcon;
  const preview = useMemo(
    () => ({
      label: "Pull request actions",
      compact: true,
      immediate: true,
      render: () => (
        <>
          <Button
            variant="ghost"
            size="xs"
            inset="symmetric"
            loading={saving}
            disabled={!writable}
            onClick={async () => {
              const current = relay.snapshot();
              if (
                !live.current ||
                !writable ||
                pending.current ||
                current.status !== "ready" ||
                current.cached ||
                current.session !== session ||
                current.scope !== scope
              )
                return;
              if (linked && pulls.get(channelId)?.url !== url) return;
              pending.current = true;
              setSaving(true);
              setError(undefined);
              try {
                const next = linked ? null : url;
                await writeLink(session, channelId, next);
                pulls.linked(channelId, next);
              } catch (reason) {
                if (live.current)
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Couldn’t save this chat’s pull request. Try again.",
                  );
              } finally {
                pending.current = false;
                if (live.current) setSaving(false);
              }
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {linked ? "Unlink from chat" : "Link to chat"}
          </Button>
          {!writable && (
            <p className={styles.pullActionNote}>
              Reconnect to your writable Solo chat to change its linked pull
              request.
            </p>
          )}
          {error && (
            <p role="alert" className={styles.pullActionError}>
              {error}
            </p>
          )}
        </>
      ),
    }),
    [
      writable,
      saving,
      linked,
      relay,
      session,
      scope,
      channelId,
      url,
      pulls,
      Icon,
      error,
    ],
  );
  useEffect(() => {
    offer(preview);
    return () => offer(undefined);
  }, [offer, preview]);
  return null;
}
