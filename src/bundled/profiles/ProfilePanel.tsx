import { ProfileAgentActions } from "./ProfileAgentActions";
import { ProfileMemories } from "./ProfileMemories";
import { relayOrigin } from "../../features/communities/destination";
import type { AgentControl } from "../../features/agents/control";
import { ProfileInstances } from "./ProfileInstances";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileChannels } from "./ProfileChannels";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import {
  PresenceIndicator,
  usePresenceStatus,
} from "../../features/presence/react";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ProfileActivity } from "./ProfileActivity";
import type { PanelProps } from "../../features/panels/service";
import { profileKey, profileTarget } from "../../features/profiles/target";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Profiles.module.css";

export function ProfilePanel({
  relay,
  target,
  context,
  navigation,
  control,
}: PanelProps & {
  relay: RelayData;
  navigation?: Navigation;
  control?: AgentControl;
}) {
  const connection = useRelayConnection(relay);
  const pubkey = profileKey(target);
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  return (
    <ProfileDetails
      key={`${connection.scope}:${connection.generation}:${pubkey}`}
      session={connection.session}
      pubkey={pubkey}
      context={context}
      navigation={navigation}
      control={control}
      scope={connection.scope}
      viewer={connection.viewer}
    >
      {control && (
        <ProfileAgentActions control={control} relay={relay} pubkey={pubkey} />
      )}
    </ProfileDetails>
  );
}
function ProfileDetails({
  children,
  session,
  pubkey,
  context,
  navigation,
  control,
  scope,
  viewer,
}: {
  children?: ReactNode;
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  navigation: Navigation | undefined;
  control: AgentControl | undefined;
  scope: string | undefined;
  viewer: string | undefined;
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profile = profiles.get(pubkey);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, retry] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const [tab, setTab] = useState<"info" | "channels" | "memories">("info");
  const region = useRef<HTMLElement>(null);
  const messageAttempt = useRef<AbortController>(undefined);
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [userStatus, setUserStatus] = useState<{
    text: string;
    emoji: string;
  }>();
  useEffect(() => {
    region.current?.focus();
    // Target, viewer and community changes remount this view (see key above).
    return () => messageAttempt.current?.abort();
  }, []);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (active) setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt]);
  // One snapshot of the self-published NIP-38 status; not live-updated.
  useEffect(() => {
    const controller = new AbortController();
    void session
      .read(
        [{ kinds: [30315], authors: [pubkey], "#d": ["general"], limit: 1 }],
        { signal: controller.signal },
      )
      .then(
        (events) => {
          if (controller.signal.aborted) return;
          const latest = events
            .filter((event) => event.pubkey === pubkey && event.kind === 30315)
            .sort((a, b) => b.created_at - a.created_at)[0];
          const emoji =
            latest?.tags.find(([name]) => name === "emoji")?.[1] ?? "";
          const text = latest?.content.trim() ?? "";
          setUserStatus(text || emoji ? { text, emoji } : undefined);
        },
        () => {},
      );
    return () => controller.abort();
  }, [session, pubkey]);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const presence = usePresenceStatus(session.presence, pubkey, true);
  let communityOrigin: string | undefined;
  if (scope && viewer && scope.endsWith(`:${viewer}`)) {
    try {
      communityOrigin = relayOrigin(scope.slice(0, -(viewer.length + 1)));
    } catch {
      // This session has no usable navigation scope.
    }
  }
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const identityName = useChannelIdentityNames(session, context?.channelId);
  const name = identityName(pubkey, profile?.name ?? "Unknown profile");
  const picture = profile?.picture
    ? (session.media(profile.picture) ?? null)
    : null;
  // As in New message, a known agent needs this community's ready native control.
  const messageable = () =>
    !agentPubkeys.has(pubkey) ||
    session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.managed && agent.pubkey === pubkey);
  const canMessage =
    session.directMessages.available &&
    !!navigation &&
    !!viewer &&
    !!communityOrigin &&
    viewer !== pubkey &&
    messageable();
  async function openMessage() {
    if (
      messageAttempt.current ||
      !navigation ||
      !viewer ||
      !communityOrigin ||
      !messageable()
    )
      return;
    const controller = new AbortController();
    messageAttempt.current = controller;
    setOpeningMessage(true);
    setMessageError("");
    try {
      const channelId = await session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (controller.signal.aborted) return;
      void navigation.open({
        version: 1,
        kind: "conversation",
        channelId,
        scope: { viewer, communityOrigin },
      });
    } catch (reason) {
      if (!controller.signal.aborted)
        setMessageError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      messageAttempt.current = undefined;
      if (!controller.signal.aborted) setOpeningMessage(false);
    }
  }
  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      tabIndex={-1}
      className={styles.root}
    >
      <div
        className={`${styles.identity} ${picture ? styles.withPortrait : ""}`}
      >
        <div className={picture ? styles.portrait : undefined}>
          <Avatar
            src={picture}
            alt={
              tab === "info" && presence !== "unknown" ? "" : `${name} avatar`
            }
            fallback={name}
            size={picture ? "fill" : "large"}
            shape={agentPubkeys.has(pubkey) ? "squircle" : "circle"}
            statusBadge={presence === "unknown" ? undefined : presence}
          />
        </div>
        <h2 className="text-heading">{name}</h2>
      </div>
      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "info", label: "Info" },
          { value: "channels", label: "Channels" },
          { value: "memories", label: "Memories" },
        ]}
        label="Profile sections"
        variant="panel"
        renderPanel={(selected) => (
          <div className={styles.tabContent}>
            {selected === "info" ? (
              <>
                <PresenceIndicator
                  presence={session.presence}
                  pubkey={pubkey}
                  profile
                />
                {userStatus && (
                  <p className={styles.status}>
                    {userStatus.emoji && <span>{userStatus.emoji}</span>}
                    {userStatus.emoji && userStatus.text && " "}
                    {userStatus.text && <span>{userStatus.text}</span>}
                  </p>
                )}
                {profile?.nip05 && (
                  <p className={styles.identifier}>
                    <span>NIP-05 (unverified)</span>{" "}
                    <span>{profile.nip05}</span>
                  </p>
                )}
                {canMessage && (
                  <div>
                    <Button
                      size="compact"
                      loading={openingMessage}
                      onClick={() => void openMessage()}
                    >
                      Message
                    </Button>
                    {messageError && <p role="alert">{messageError}</p>}
                  </div>
                )}
                {profile?.about && (
                  <p className={styles.about}>{profile.about}</p>
                )}
                {children}
                <ProfileActivity
                  session={session}
                  pubkey={pubkey}
                  context={context}
                />
                {control && (
                  <ProfileInstances
                    errorHandledByActions
                    control={control}
                    pubkey={pubkey}
                    navigation={navigation}
                    scope={scope}
                    communityOrigin={communityOrigin}
                    viewer={viewer}
                    knownAgent={agentPubkeys.has(pubkey)}
                  />
                )}
                <div className={styles.publicKey}>
                  <div className={styles.keyHeading}>
                    <h3 className="text-body">Public key</h3>
                    <Button
                      size="compact"
                      variant="ghost"
                      aria-label="Copy npub"
                      onClick={() => {
                        setCopyStatus("");
                        void Promise.resolve()
                          .then(() => navigator.clipboard.writeText(npub))
                          .then(
                            () => setCopyStatus("Public key copied."),
                            () =>
                              setCopyStatus(
                                "Could not copy. Select the public key above to copy it.",
                              ),
                          );
                      }}
                    >
                      <CopyIcon size={16} aria-hidden="true" />
                      Copy
                    </Button>
                  </div>
                  <code className="font-mono text-mono">{npub}</code>
                  <span role="status" className={styles.feedback}>
                    {copyStatus}
                  </span>
                </div>
                {!profile &&
                  (status === "loading" ? (
                    <p role="status">Loading profile…</p>
                  ) : (
                    <>
                      <p role={status === "error" ? "alert" : undefined}>
                        {status === "error"
                          ? "Could not load this profile."
                          : "No profile metadata is available in this community."}
                      </p>
                      <Button
                        size="compact"
                        onClick={() => retry((value) => value + 1)}
                      >
                        Retry profile
                      </Button>
                    </>
                  ))}
              </>
            ) : selected === "memories" ? (
              <ProfileMemories session={session} pubkey={pubkey} />
            ) : (
              <ProfileChannels
                session={session}
                pubkey={pubkey}
                navigation={navigation}
                communityOrigin={communityOrigin}
                viewer={viewer}
                control={control}
                scope={scope}
              />
            )}
          </div>
        )}
      />
    </section>
  );
}
