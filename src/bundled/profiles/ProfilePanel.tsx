import { ProfileHeaderTime } from "../../features/profiles/ProfileHeaderTime";
import { createPortal } from "react-dom";
import { ProfileInfoBento } from "./ProfileInfoBento";
import { ProfileLocationPreview } from "./ProfileLocationPreview";
import type { ManagedProfile } from "../../features/profiles/managed-profile";
import { ProviderProfileRow } from "./ProviderProfileRow";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { historyPresentation } from "../../features/agents/history-presentation";
import {
  profileHistoryActive,
  profileHistoryRoute,
  profileHistoryTarget,
} from "../../features/profiles/target";
import { useProfileMessage } from "../../features/profiles/useProfileMessage";
import {
  AgentSaveState,
  DiscardChanges,
  useAgentSaveReports,
} from "../../features/agents/AgentSaveButton";
import { AgentDetails } from "../agents/AgentDetails";
import { AgentMessageButton } from "../agents/AgentMessageButton";
import { useAgents } from "../../features/agents/react";
import {
  usePanelTabHost,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { useAgentOwnerEvidence } from "../../features/profiles/useAgentOwnerEvidence";
import { ProfileStatusBubble } from "../../features/profiles/ProfileStatusBubble";
import { StatusEditor } from "../../features/user-status/StatusEditor";
import { useStatusEditor } from "../../features/user-status/useStatusEditor";
import { useUserStatus } from "../../features/user-status/useUserStatus";
import { ProfilePublicMetadata } from "./ProfilePublicMetadata";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileChannels } from "./ProfileChannels";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  CopyIcon,
  RobotIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { TranscriptFocus } from "../../features/agents/ActivityTranscript";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { PanelProps } from "../../features/panels/service";
import {
  claimProfileTranscript,
  claimTranscriptFocus,
  profileActivityViewKey,
  profileTranscriptRequest,
  readerInputs,
  subscribeProfileTranscripts,
  profileAgentHint,
  profilePanelKey,
  profileTarget,
} from "../../features/profiles/target";
import {
  abbreviatedPublicKey,
  formatPublicKey,
} from "../../shared/identity/public-key";
import { selectProfiles } from "../../features/relay/profile-selection";
import {
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ProfileAgentIdentity } from "./ProfileAgentIdentity";
import styles from "./Profiles.module.css";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import hero from "../../features/profiles/ProfileHero.module.css";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentDelete } from "../../features/agents/AgentManage";
import { useAgent, useChannelChoices } from "../../features/agents/react";
import type {
  Agents,
  AgentViewProps,
  TranscriptRequest,
} from "../../features/agents/service";
import type { CommunityReader } from "../../features/communities/service";
import { agentSections } from "../../features/agents/tabs";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { useAgentSettingsHost } from "../agents/AgentSettingsHost";
import { conversationOpener } from "../agents/routes";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import type { NavigationScope } from "../../features/navigation/targets";
import { avatarMedia, avatarSource } from "../../shared/avatar-source";
import { writeClipboardText } from "../../shared/clipboard";

const noSubscribe = () => () => {};
const emptyAgentTypes = Object.freeze([]);
/** This session's community, which targets opened from the panel stay in. */
function panelCommunity(scope: string | undefined, viewer: string | undefined) {
  if (!scope || !viewer || !scope.endsWith(`:${viewer}`)) return undefined;
  try {
    return {
      viewer,
      communityOrigin: relayOrigin(scope.slice(0, -(viewer.length + 1))),
    };
  } catch {
    // This session has no usable navigation scope.
    return undefined;
  }
}

/** The conversation the profile was opened from. Agents keep a Solo chat or
 * a DM as one conversation, so a message's thread there is not its own. */
function openedFrom(session: RelaySession, context: PanelProps["context"]) {
  if (!context) return undefined;
  const kind = session.channels
    .list()
    .channels.find((item) => item.id === context.channelId)?.channelType;
  const whole = kind === "solo" || kind === "dm";
  return {
    channelId: context.channelId,
    ...(context.rootId && !whole && { rootId: context.rootId }),
  };
}

/** Optional Info composition for a panel specializing canonical person profiles. */
export type PersonProfileInfoContent = {
  /** Optional display data supplied by the caller; this component never fetches or saves it. */
  managedProfile?: ManagedProfile | undefined;
  renderPersonFields?:
    | ((context: {
        session: RelaySession | undefined;
        section: "personal" | "team" | "location";
        pubkey: string;
        verifiedUsername: string | undefined;
        managed?: ManagedProfile;
        communityOrigin: string | undefined;
        renderRow: (
          title: string,
          value: string,
          profileUsername?: string,
        ) => ReactNode;
      }) => ReactNode)
    | undefined;
  renderPersonInfo?: ((content: ReactNode) => ReactNode) | undefined;
};
const plainInfo = (content: ReactNode) => content;

export function ProfilePanel({
  relay,
  target,
  context,
  navigation,
  agents,
  communities,
  linkRenderers,
  close,
  renderPersonInfo,
  renderPersonFields,
  managedProfile,
}: PanelProps &
  PersonProfileInfoContent & {
    relay: RelayData;
    navigation?: Navigation;
    /** Agents show their type's tabs. */
    agents?: Agents;
    communities?: CommunityReader | undefined;
    linkRenderers?: ConversationExtensions["links"] | undefined;
  }) {
  const connection = useRelayConnection(relay);
  const activityKey = profileActivityViewKey(target);
  const opening = activityKey ? "activity" : "info";
  // Asked once per opening. This profile takes the opening as soon as it is
  // shown, even on another section, so remounting with the channel finds
  // nothing to reopen; changing sections back after it was offered does not
  // ask again either.
  const asked = useSyncExternalStore(subscribeProfileTranscripts, () =>
    activityKey ? profileTranscriptRequest(target) : undefined,
  );
  const [held, setHeld] = useState<number>();
  const [offered, setOffered] = useState(0);
  // The latest opening's message, until its transcript has shown it.
  const [focus, setFocus] = useState<{
    opening: number;
    events: readonly string[];
    inputs: number;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new opening is claimed.
  useEffect(() => {
    const claimed = claimProfileTranscript(target);
    if (claimed === undefined) return;
    setHeld(claimed);
    const events = claimTranscriptFocus(claimed);
    // Claimed as it opens: presses and keys from here on are the reader's own.
    setFocus(events && { opening: claimed, events, inputs: readerInputs() });
  }, [asked, target]);
  const shown = useMemo(
    () =>
      focus && {
        events: focus.events,
        inputs: focus.inputs,
        done: () =>
          setFocus((current) =>
            current?.opening === focus.opening ? undefined : current,
          ),
      },
    [focus],
  );
  const pending = asked ?? held;
  const request =
    pending !== undefined && pending > offered ? pending : undefined;
  const initialTranscript = useMemo(
    () =>
      request === undefined
        ? undefined
        : {
            opening: request,
            done: () => setOffered((last) => Math.max(last, request)),
          },
    [request],
  );
  const pubkey = profilePanelKey(target) ?? activityKey;
  const owned = useAgent(agents, pubkey ?? "");
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  // An agent's activity opens a turn's conversation in this community.
  const openConversation = conversationOpener(
    navigation,
    panelCommunity(connection.scope, connection.viewer),
  );
  const owner =
    agents &&
    owned &&
    owned.agent.owner === connection.viewer &&
    !owned.agent.unfinished &&
    owned.agent.place !== "elsewhere";
  return (
    <TranscriptFocus.Provider value={shown}>
      {owner ? (
        <OwnedAgentProfile
          linkRenderers={linkRenderers}
          target={target}
          key={`${connection.scope}:${connection.generation}:${pubkey}:${opening}`}
          agents={agents}
          communities={communities}
          initialActivity={!!activityKey}
          initialTranscript={initialTranscript}
          pubkey={pubkey}
          relay={relay}
          session={connection.session}
          scope={panelCommunity(connection.scope, connection.viewer)}
          navigation={navigation}
          context={context}
          openConversation={openConversation}
          close={close}
        />
      ) : (
        <ProfileDetails
          managedProfile={managedProfile}
          renderPersonFields={renderPersonFields}
          renderPersonInfo={renderPersonInfo}
          linkRenderers={linkRenderers}
          key={`${connection.scope}:${connection.generation}:${pubkey}:${opening}`}
          initialTab={activityKey ? "activity" : "info"}
          initialTranscript={initialTranscript}
          session={connection.session}
          pubkey={pubkey}
          agentHint={profileAgentHint(target) || !!activityKey}
          context={context}
          navigation={navigation}
          agents={agents}
          communities={communities}
          scope={connection.scope}
          viewer={connection.viewer}
          openConversation={openConversation}
          close={close}
        />
      )}
    </TranscriptFocus.Provider>
  );
}
function OwnedAgentProfile({
  linkRenderers,
  target,
  agents,
  communities,
  initialActivity,
  initialTranscript,
  pubkey,
  relay,
  session,
  scope,
  navigation,
  context,
  openConversation,
  close,
}: {
  target: string;
  linkRenderers: ConversationExtensions["links"] | undefined;
  agents: Agents;
  communities: CommunityReader | undefined;
  initialActivity: boolean;
  initialTranscript: TranscriptRequest | undefined;
  pubkey: string;
  relay: RelayData;
  session: RelaySession;
  scope: NavigationScope | undefined;
  navigation: Navigation | undefined;
  context: PanelProps["context"];
  openConversation: AgentViewProps["openConversation"];
  close(): void;
}) {
  const { types } = useAgents(agents);
  const owned = useAgent(agents, pubkey);
  const channels = useChannelChoices(session.channels);
  // Unsaved edits are asked about before a link replaces this profile.
  const [unsaved, reportUnsaved] = useAgentSaveReports();
  const [leaving, setLeaving] = useState<string>();
  if (leaving && !unsaved.dirty) setLeaving(undefined);
  if (!owned) return null;
  const address = navigation?.snapshot().entry.target;
  const conversationTarget = (link: string) => {
    const target = scope && buzzLinkTarget(link, scope);
    return target?.kind === "conversation" ? target : undefined;
  };
  const go = (link: string) => {
    const target = conversationTarget(link);
    if (target && navigation) {
      void navigation.open(target);
      return true;
    }
    return (context?.push ?? context?.open)?.(link);
  };
  const openLink = (link: string) => {
    if (!context?.canOpen(link) && !(navigation && conversationTarget(link)))
      return false;
    if (!unsaved.saving && !unsaved.dirty) return !!go(link);
    if (!unsaved.saving) setLeaving(link);
    return false;
  };
  return (
    <AgentSaveState value={reportUnsaved}>
      <AgentDetails
        historyPresentation={
          navigation &&
          address?.kind === "conversation" &&
          address.detail?.target === target
            ? historyPresentation(
                navigation,
                profileHistoryRoute(target),
                (selected) => ({
                  ...address,
                  detail: {
                    ...address.detail,
                    target: profileHistoryTarget(target, selected),
                  },
                }),
                profileHistoryActive(target),
              )
            : undefined
        }
        agents={agents}
        communities={communities}
        agent={owned.agent}
        type={owned.type}
        types={types}
        channels={channels}
        memories={session.agentMemories}
        memoryLinks={{ session, registry: linkRenderers, open: openLink }}
        onRemoved={close}
        initialActivity={initialActivity}
        initialTranscript={initialTranscript}
        close={close}
        openConversation={openConversation}
        openLink={context && openLink}
        canOpenLink={context && ((link) => context.canOpen(link))}
        conversation={openedFrom(session, context)}
        messageAction={(variant) => (
          <AgentMessageButton
            variant={variant}
            pubkey={pubkey}
            relay={relay}
            navigator={navigation}
            navigation={undefined}
          />
        )}
        openSettings={
          navigation &&
          ((section) =>
            void navigation.open({ version: 1, kind: "settings", section }))
        }
      />
      {leaving && (
        <DiscardChanges
          description={`Your unsaved changes to ${owned.agent.name} will be lost.`}
          onKeep={() => setLeaving(undefined)}
          onDiscard={() => {
            setLeaving(undefined);
            go(leaving);
          }}
        />
      )}
    </AgentSaveState>
  );
}

function ProfileDetails({
  linkRenderers,
  initialTab,
  initialTranscript,
  agentHint,
  session,
  pubkey,
  context,
  navigation,
  agents,
  communities,
  scope,
  viewer,
  openConversation,
  close,
  renderPersonInfo = plainInfo,
  renderPersonFields,
  managedProfile,
}: PersonProfileInfoContent & {
  agents: Agents | undefined;
  linkRenderers: ConversationExtensions["links"] | undefined;
  communities: CommunityReader | undefined;
  initialTab: "info" | "activity";
  initialTranscript: TranscriptRequest | undefined;
  agentHint: boolean;
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  navigation: Navigation | undefined;
  scope: string | undefined;
  viewer: string | undefined;
  openConversation: AgentViewProps["openConversation"];
  close(): void;
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
  // Retry stays mounted and focusable while its own read is pending.
  const [retrying, setRetrying] = useState(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const [tab, setTab] = useState<
    "info" | "activity" | "channels" | `agent:${string}`
  >(initialTab);
  // A new transcript request shows Activity, as choosing its tab would.
  const opening = initialTranscript?.opening;
  const [asked, setAsked] = useState(opening);
  if (opening !== asked) {
    setAsked(opening);
    if (opening !== undefined) setTab("activity");
  }
  // An agent's sections come from its type and the app, not the harness.
  const plugin = useAgent(agents, pubkey);
  const agentTypes = useSyncExternalStore(
    agents?.subscribe ?? noSubscribe,
    agents?.types ?? (() => emptyAgentTypes),
    () => emptyAgentTypes,
  );
  const settings = useAgentSettingsHost({
    agents,
    agent: plugin?.agent,
    type: plugin?.type,
    types: agentTypes,
  });
  const sections =
    settings.agent && agents
      ? agentSections({
          agents,
          agent: settings.agent,
          type: settings.type,
          memories: session.agentMemories,
          memoryLinks: {
            session,
            registry: linkRenderers,
            open: (url) => !!context?.open(url),
          },
          communities,
          conversation: openedFrom(session, context),
          initialTranscript,
          close,
          ...(openConversation && { openConversation }),
          ...(settings.settingsHost
            ? { settingsHost: settings.settingsHost }
            : {}),
        })
      : [];
  // Opened for activity, an agent shows its type's Activity tab (its
  // sessions), or its first tab when its type has none.
  const typeActivity = sections.find((item) => item.value === "agent:activity");
  const requestedTab =
    tab === "activity" ? ((typeActivity ?? sections[0])?.value ?? "info") : tab;
  const section = sections.find((item) => item.value === requestedTab);
  const tabHost = usePanelTabHost();
  const tabbed = !!tabHost;
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!tabbed) region.current?.focus();
  }, [tabbed]);
  const profileGeneration = useProfileGeneration(session.profiles);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery; a purge generation rereads.
  useEffect(() => {
    let active = true;
    // A purge reread must not unmount a focused Retry: keep it pending, and
    // let success hand its focus to the stable region as an explicit retry does.
    if (document.activeElement === retryButton.current) setRetrying(true);
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (!active) return;
        // Retry unmounts on success; hand its focus to the stable region.
        if (document.activeElement === retryButton.current)
          region.current?.focus();
        setStatus("ready");
        setRetrying(false);
      },
      () => {
        if (!active) return;
        setStatus("error");
        setRetrying(false);
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt, profileGeneration]);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const presence = usePresenceStatus(session.presence, pubkey, true);
  const knownAgent = agentPubkeys.has(pubkey);
  // Navigation can conservatively identify an agent; it grants no private control.
  const displayAgent = knownAgent || agentHint;
  const ownership = useAgentOwnerEvidence(
    session,
    knownAgent ? pubkey : undefined,
    attempt,
  );
  const verifiedOwner = ownership.owner;
  const selectedTab =
    requestedTab.startsWith("agent:") && !section ? "info" : requestedTab;
  const community = panelCommunity(scope, viewer);
  const communityOrigin = community?.communityOrigin;
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const identityName = useChannelIdentityNames(session, context?.channelId);
  const name = identityName(
    pubkey,
    profile?.name ??
      (displayAgent ? "Unknown agent" : (formatPublicKey(pubkey) ?? pubkey)),
  );
  const headingName =
    profile?.verified?.fullName ?? profile?.verified?.displayName ?? name;
  // The portrait is 5rem (at most 240 device px), so the relay's 320 px
  // thumbnail already covers it and reuses the URL message rows have loaded.
  const picture = avatarMedia(profile?.picture, session.media) ?? null;
  const tabAvatar = useMemo(
    () => (
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="fill"
        shape={knownAgent ? "squircle" : "circle"}
      />
    ),
    [picture, name, knownAgent],
  );
  usePanelTabTitle(name, tabAvatar);
  // Targets opened from this panel stay in its community.
  const scoped =
    navigation && community ? { navigation, scope: community } : undefined;
  const {
    available: canMessage,
    opening: openingMessage,
    error: messageError,
    open: openMessage,
  } = useProfileMessage({
    session,
    pubkey,
    viewer,
    agent: displayAgent,
    enabled: !!scoped,
    onOpened(link) {
      const target = scoped && buzzLinkTarget(link, scoped.scope);
      if (target) void scoped.navigation.open(target);
    },
  });
  const canEdit = !!scoped && viewer === pubkey;
  // Settings edits the selected community's profile, so bind it to this one.
  const editProfile = () =>
    void scoped?.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
      scope: scoped.scope,
    });
  // This panel's session is its community's, so the status saves there.
  const statusEditor = useStatusEditor(session, viewer);
  const statusButton = useRef<HTMLButtonElement>(null);
  const userStatus = useUserStatus(session.statuses, pubkey);
  const canSetStatus =
    !!scope && viewer === pubkey && session.statuses.writable;

  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoHost, setPhotoHost] = useState<HTMLElement>();
  const [photoBounds, setPhotoBounds] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  }>();
  useLayoutEffect(() => {
    if (!photoOpen || !region.current) return;
    let viewport = region.current.parentElement;
    while (
      viewport &&
      !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)
    ) {
      viewport = viewport.parentElement;
    }
    if (!viewport) return;
    const scroller = viewport;
    setPhotoHost(scroller.parentElement ?? scroller);
    const overflow = scroller.style.overflowY;
    const scrollTop = scroller.scrollTop;
    const update = () => {
      const rect = scroller.getBoundingClientRect();
      setPhotoBounds({
        top: rect.top,
        left: rect.left,
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      });
    };
    update();
    scroller.style.overflowY = "hidden";
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      scroller.style.overflowY = overflow;
      scroller.scrollTop = scrollTop;
    };
  }, [photoOpen]);
  const photoId = useId();
  const photoButton = useRef<HTMLButtonElement>(null);
  const photoClose = useRef<HTMLButtonElement>(null);
  const expandedPhoto = useRef<HTMLImageElement>(null);
  const fullPhotoSource = avatarSource(profile?.picture);
  const fullPhoto = fullPhotoSource?.startsWith("data:")
    ? fullPhotoSource
    : fullPhotoSource
      ? session.media(fullPhotoSource)
      : undefined;
  const [readyPhoto, setReadyPhoto] = useState<string>();
  useEffect(() => {
    if (!fullPhoto) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      void (image.decode?.() ?? Promise.resolve())
        .then(() => {
          if (active) setReadyPhoto(fullPhoto);
        })
        .catch(() => {
          // Keep the visible thumbnail if the original cannot be decoded.
        });
    };
    image.src = fullPhoto;
    return () => {
      active = false;
    };
  }, [fullPhoto]);
  const reducedMotion = useReducedMotion();
  const [keyboardPhoto, setKeyboardPhoto] = useState(false);
  const managed = managedProfile;
  const providerFields = (section: "personal" | "team" | "location") =>
    !displayAgent &&
    renderPersonFields?.({
      session,
      section,
      pubkey,
      verifiedUsername:
        profile?.verified?.status === "checked"
          ? profile.verified.username
          : undefined,
      ...(managed ? { managed } : {}),
      communityOrigin: community?.communityOrigin,
      renderRow: (title, value, profileUsername) =>
        profileUsername && context ? (
          <ProviderProfileRow
            key={profileUsername}
            title={title}
            value={value}
            username={profileUsername}
            session={session}
            open={(target) => (context.push ?? context.open)(target)}
          />
        ) : (
          <PreferenceRow
            title={title}
            subtitle={
              <span className="text-body-sm text-secondary">{value}</span>
            }
          />
        ),
    });
  const providerTeam = providerFields("team");
  const providerLocation = providerFields("location");
  const photoTransition = {
    duration: reducedMotion || keyboardPhoto ? 0 : 0.22,
    ease: "easeOut" as const,
  };
  const closePhoto = () => {
    setPhotoOpen(false);
    requestAnimationFrame(() =>
      photoButton.current?.focus({ preventScroll: true }),
    );
  };
  useEffect(() => {
    if (!photoOpen || !photoHost) return;
    photoClose.current?.focus();
    const outsidePhoto = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        expandedPhoto.current?.contains(target) ||
        photoClose.current?.contains(target)
      )
        return;
      setPhotoOpen(false);
      // Preserve focus on a control clicked outside the panel.
      if (region.current?.contains(target)) {
        requestAnimationFrame(() =>
          photoButton.current?.focus({ preventScroll: true }),
        );
      }
    };
    document.addEventListener("pointerdown", outsidePhoto, true);
    return () =>
      document.removeEventListener("pointerdown", outsidePhoto, true);
  }, [photoOpen, photoHost]);

  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      tabIndex={-1}
      className={styles.root}
      onKeyDownCapture={(event) => {
        if (photoOpen && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closePhoto();
        }
      }}
    >
      <div
        className={styles.profileContents}
        data-photo-open={photoOpen || undefined}
        data-photo-instant={keyboardPhoto || undefined}
        inert={photoOpen}
      >
        <div data-profile-hero="" className={`${hero.hero} ${hero.panelHero}`}>
          <ProfileBackdrop src={picture} />
          <ProfileStatusBubble session={session} pubkey={pubkey} />
          <motion.button
            layoutId={photoId}
            transition={photoTransition}
            ref={photoButton}
            type="button"
            className={styles.portrait}
            disabled={!picture}
            aria-label="Enlarge profile photo"
            onClick={(event) => {
              setKeyboardPhoto(event.detail === 0);
              setPhotoOpen(true);
            }}
          >
            <AgentAvatar
              session={session}
              agentPubkey={pubkey}
              channelId={context?.channelId}
              src={picture}
              alt={`${name} avatar`}
              fallback={name}
              size="fill"
              shape={displayAgent ? "squircle" : "circle"}
              statusBadge={presence === "unknown" ? undefined : presence}
              statusTooltip={
                presence === "online"
                  ? "Online"
                  : presence === "away"
                    ? "Away"
                    : "Offline"
              }
            />
          </motion.button>
          <div className={styles.identity}>
            <h2 className="text-heading">
              {displayAgent && <RobotIcon className={styles.agentIcon} />}
              {headingName}
            </h2>
            <ProfileHeaderTime
              session={session}
              pubkey={pubkey}
              managed={managed}
            />
          </div>
          {(canSetStatus || canMessage || canEdit) && (
            <div className={hero.actions}>
              {canEdit && (
                <Button
                  size="sm"
                  variant={picture ? "glass" : "subtle"}
                  onClick={editProfile}
                >
                  Edit profile
                </Button>
              )}
              {canSetStatus && (
                <Button
                  ref={statusButton}
                  size="sm"
                  variant={picture ? "glass" : "subtle"}
                  aria-haspopup="dialog"
                  onClick={() => statusEditor.open()}
                >
                  {userStatus ? "Update status" : "Set a status"}
                </Button>
              )}
              {canMessage && (
                <Button
                  size="sm"
                  variant={picture ? "glass" : "subtle"}
                  loading={openingMessage}
                  onClick={() => void openMessage()}
                >
                  Message
                </Button>
              )}
            </div>
          )}
          {messageError && (
            <p role="alert" className="text-body-sm text-danger">
              {messageError}
            </p>
          )}
        </div>
        <Tabs
          value={selectedTab}
          onValueChange={setTab}
          items={[
            { value: "info", label: "Info" },
            ...sections.map(({ value, label }) => ({ value, label })),
            { value: "channels", label: "Channels" },
          ]}
          label="Profile sections"
          variant="panel"
          renderPanel={(selected) => (
            <div className={styles.tabContent}>
              {selected.startsWith("agent:") ? (
                sections.find((item) => item.value === selected)?.render()
              ) : selected === "info" ? (
                (displayAgent ? plainInfo : renderPersonInfo)(
                  <>
                    {!displayAgent && managed ? (
                      <ProfileInfoBento
                        picture={picture ?? undefined}
                        managed={managed}
                        npub={npub}
                        username={
                          profile?.verified?.username ?? profile?.username
                        }
                        about={profile?.about}
                        timeZone={profile?.tz}
                        session={session}
                        open={
                          context
                            ? (target) => (context.push ?? context.open)(target)
                            : undefined
                        }
                      />
                    ) : (
                      <>
                        {!displayAgent && (
                          <section
                            className="grid gap-3"
                            aria-label="Personal info"
                          >
                            <h3 className="m-0 text-label">Personal info</h3>
                            <SettingsGroup>
                              {(profile?.verified?.username ||
                                profile?.username) && (
                                <PreferenceRow
                                  title="Username"
                                  subtitle={
                                    <span className="text-body-sm text-secondary">
                                      {`@${profile?.verified?.username ?? profile?.username}`}
                                    </span>
                                  }
                                />
                              )}
                              {providerFields("personal")}
                              {profile?.about && (
                                <PreferenceRow
                                  title="About"
                                  subtitle={
                                    <span className="text-body-sm text-secondary">
                                      {profile.about}
                                    </span>
                                  }
                                />
                              )}
                            </SettingsGroup>
                          </section>
                        )}
                        {providerTeam && (
                          <section className="grid gap-3" aria-label="Team">
                            <h3 className="m-0 text-label">Team</h3>
                            <SettingsGroup>{providerTeam}</SettingsGroup>
                          </section>
                        )}
                        {(profile?.tz ||
                          managed?.timezone ||
                          providerLocation) && (
                          <section className="grid gap-3" aria-label="Location">
                            <h3 className="m-0 text-label">Location</h3>
                            <ProfileLocationPreview
                              location={
                                managed?.fields.find(
                                  (field) => field.key === "location",
                                )?.value || managed?.city
                              }
                              timeZone={managed?.timezone ?? profile?.tz}
                              fallback={providerLocation}
                            />
                          </section>
                        )}
                      </>
                    )}
                    {displayAgent && profile?.about && (
                      <SettingsGroup layout="form">
                        <p className={styles.about}>{profile.about}</p>
                      </SettingsGroup>
                    )}
                    {plugin && agents && plugin.agent.place !== "elsewhere" && (
                      <div>
                        <AgentDelete
                          agents={agents}
                          agent={plugin.agent}
                          onRemoved={close}
                        />
                      </div>
                    )}
                    {(displayAgent || !managed) && (
                      <div className={styles.publicKey}>
                        <SettingsGroup>
                          <PreferenceRow
                            title="Public key"
                            subtitle={
                              <code
                                className={`${styles.keyValue} text-body-sm text-secondary`}
                                title={npub}
                              >
                                {abbreviatedPublicKey(pubkey, 5) ?? npub}
                              </code>
                            }
                            trailing={
                              <Button
                                size="compact"
                                variant="subtle"
                                aria-label="Copy npub"
                                onClick={() => {
                                  setCopied(false);
                                  void Promise.resolve()
                                    .then(() => writeClipboardText(npub))
                                    .then(
                                      () => setCopied(true),
                                      () =>
                                        notify(
                                          "Could not copy the public key. Try again.",
                                          "error",
                                        ),
                                    );
                                }}
                              >
                                {copied ? (
                                  <CheckIcon size={16} aria-hidden="true" />
                                ) : (
                                  <CopyIcon size={16} aria-hidden="true" />
                                )}
                                <span aria-live="polite">
                                  {copied ? "Copied" : "Copy"}
                                </span>
                              </Button>
                            }
                          />
                        </SettingsGroup>
                      </div>
                    )}
                    {knownAgent && verifiedOwner && (
                      <ProfileAgentIdentity
                        session={session}
                        owner={verifiedOwner}
                        viewer={viewer}
                        context={context}
                      />
                    )}
                    <ProfilePublicMetadata nip05={profile?.nip05} />
                    {/* A verified overlay can exist while its kind-0 read failed. */}
                    {(!profile ||
                      (profile.verified && (status === "error" || retrying))) &&
                      (status === "loading" ? (
                        <p role="status">Loading profile…</p>
                      ) : (
                        <p role={status === "error" ? "alert" : undefined}>
                          {status === "error"
                            ? "Could not load this profile."
                            : "No profile metadata is available in this community."}
                        </p>
                      ))}
                    {((!profile && status !== "loading") ||
                      (profile?.verified && status === "error") ||
                      retrying ||
                      ownership.failed) && (
                      <Button
                        ref={retryButton}
                        size="compact"
                        loading={retrying}
                        onClick={() => {
                          setRetrying(true);
                          retry((value) => value + 1);
                        }}
                      >
                        Retry profile
                      </Button>
                    )}
                  </>,
                )
              ) : (
                <ProfileChannels
                  session={session}
                  pubkey={pubkey}
                  navigation={navigation}
                  communityOrigin={communityOrigin}
                  viewer={viewer}
                />
              )}
            </div>
          )}
        />
      </div>
      {photoHost &&
        createPortal(
          <AnimatePresence>
            {photoOpen && picture && (
              <motion.div
                className={styles.photoViewer}
                style={photoBounds ?? {}}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={photoTransition}
                data-buzz-ui=""
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closePhoto();
                  }
                }}
                aria-label="Expanded profile photo"
              >
                <motion.img
                  ref={expandedPhoto}
                  layoutId={photoId}
                  transition={photoTransition}
                  className={styles.expandedPhoto}
                  initial={{
                    filter:
                      reducedMotion || keyboardPhoto
                        ? "blur(0px)"
                        : "blur(8px)",
                  }}
                  animate={{ filter: "blur(0px)" }}
                  exit={{
                    filter:
                      reducedMotion || keyboardPhoto
                        ? "blur(0px)"
                        : "blur(8px)",
                  }}
                  src={
                    fullPhoto && readyPhoto === fullPhoto ? fullPhoto : picture
                  }
                  alt={name}
                />
                <div className={styles.photoClose}>
                  <Button
                    ref={photoClose}
                    size="sm"
                    variant="subtle"
                    onClick={closePhoto}
                  >
                    <XIcon size={16} aria-hidden="true" /> Close photo
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          photoHost,
        )}
      {statusEditor.editor && scope && (
        <StatusEditor
          session={session}
          scope={scope}
          current={statusEditor.editor.current}
          viewer={statusEditor.editor.viewer}
          close={statusEditor.close}
          finalFocus={statusButton}
        />
      )}
    </section>
  );
}
