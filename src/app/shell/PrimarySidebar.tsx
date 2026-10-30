import { NavigationDensity } from "../../shared/design-system/ui/NavigationItem";
import { SidebarConversationList } from "../../features/channel-navigation/SidebarConversationList";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SidebarRowInset } from "../../features/channel-navigation/sidebar-presentation";

import { useSyncExternalStore, type ReactNode } from "react";
import { SoloRegions } from "../../features/channel-navigation/SoloRegions";
import { SoloInventory } from "../../features/channel-navigation/SoloInventory";

import { RecoveryNotice } from "../../features/relay/RecoveryNotice";
import { ChannelInventory } from "../../features/channel-navigation/ChannelInventory";
import { SidebarBoundary } from "../../features/channel-navigation/SidebarBoundary";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import { SidebarUnread } from "../../bundled/channels/SidebarUnread";

import { Button } from "../../shared/design-system/ui/Button";
import type { RelaySession } from "../../features/relay/session";
import { CommunitySignIn } from "../../features/federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import type { RelayData } from "../../features/relay/service";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { useRelayConnection } from "../../features/relay/react";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon, ChatMenu } from "../../features/conversation/service";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import styles from "./PrimarySidebar.module.css";

type Props = {
  federatedIdentity?: FederatedIdentity;
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  chatMenus?: ContributionReader<ChatMenu> | undefined;
  sidebarSections?: SidebarSections | undefined;
  target: OpenTarget;
  children: ReactNode;
  teamNavigation?: ReactNode;
};

/** One persistent navigation surface for conversations and saved groups. */
export function PrimarySidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const scope = connection.scope ?? "disconnected";
  return (
    <ScopedSidebar
      {...props}
      key={scope}
      scope={scope}
      connection={connection}
    />
  );
}

function ScopedSidebar({
  scope,
  connection,
  ...props
}: Props & {
  scope: string;
  connection: ReturnType<typeof useRelayConnection>;
}) {
  const session = connection.session;
  const soloPreferences = useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const soloReady =
    soloPreferences.status !== "idle" && soloPreferences.status !== "loading";
  const header = props.children && (
    <div className={styles.destinations}>{props.children}</div>
  );
  return (
    <NavigationDensity value="medium">
      <SidebarBoundary
        key={`${scope}:${connection.generation}`}
        header={header}
      >
        {connection.status === "ready" || connection.cached ? (
          <ChannelInventory
            relay={props.relay}
            navigator={props.navigator}
            agents={props.agents}
            target={props.target}
            queries={session}
            scope={scope}
            viewer={connection.viewer}
            sidebarSections={props.sidebarSections}
            cached={!!connection.cached}
            layoutReady={soloReady}
            connectionError={connection.error}
            pinnedNavigation={props.teamNavigation}
            composeContent={(
              manual,
              teamRows,
              teamReveal,
              sidebar,
              pinned,
              filed,
            ) => (
              <>
                <SoloInventory
                  filedTeamRows={filed}
                  filedTeamReveal={teamReveal}
                  revealSection={(id) => sidebar.toggle(`group:${id}`, true)}
                  key={`${scope}:${connection.generation}`}
                  session={session}
                  scope={scope}
                  navigator={props.navigator}
                  target={props.target}
                  chatIcons={props.chatIcons}
                  chatMenus={props.chatMenus}
                  renderUngrouped={({
                    rows,
                    draft,
                    revealId,
                    workspaces,
                    filedRows,
                  }) => (
                    <div className={styles.groups}>
                      <SidebarRowInset value={false}>{pinned}</SidebarRowInset>
                      <SidebarConversationList
                        session={session}
                        selectedId={
                          props.target.kind === "conversation"
                            ? props.target.channelId
                            : undefined
                        }
                        rows={rows}
                        scope="solo"
                        draft={draft}
                        revealId={revealId}
                      />
                      <section
                        className={styles.savedSections}
                        aria-label="Sections"
                      >
                        <div
                          className={styles.groupHeading}
                          data-sidebar-label=""
                        >
                          <InlineHeader title="Sections" />
                        </div>
                        <SidebarRowInset value={false}>
                          {workspaces}
                          {manual(filedRows, revealId)}
                        </SidebarRowInset>
                      </section>
                      <SidebarConversationList
                        session={session}
                        selectedId={
                          props.target.kind === "conversation"
                            ? props.target.channelId
                            : undefined
                        }
                        rows={teamRows}
                        scope="team"
                        revealId={teamReveal}
                      />
                    </div>
                  )}
                  renderContents={(
                    ordinary,
                    ordinaryActions,
                    _header,
                    creationTrigger,
                    pendingClick,
                  ) => (
                    <>
                      {
                        <SoloRegions
                          session={session}
                          scope={scope}
                          navigator={props.navigator}
                          target={props.target}
                          sidebar={sidebar}
                          ordinaryActions={ordinaryActions}
                          creationTrigger={creationTrigger}
                          pendingClick={pendingClick}
                        />
                      }
                      {ordinary}
                    </>
                  )}
                />
              </>
            )}
            render={({
              sidebar,
              dmPreviews,
              frame,
              before,
              content,
              after,
              dialogs,
            }) => (
              <ResizableSidebar scope={scope} className="shell-sidebar">
                <SidebarFrame label="Sidebar" header={header} {...frame}>
                  {!connection.cached && (
                    <RecoveryNotice recovery={session.recovery} />
                  )}
                  <LiveSignIn
                    session={session}
                    identity={props.federatedIdentity}
                  />
                  {before}
                  <SidebarUnread listRef={sidebar.list} dmPreviews={dmPreviews}>
                    {content}
                  </SidebarUnread>
                  {after}
                </SidebarFrame>
                {dialogs}
              </ResizableSidebar>
            )}
          />
        ) : (
          <div className="shell-sidebar-default">
            <SidebarFrame
              label="Sidebar"
              header={header}
              launchPending={
                connection.status === "connecting" ? "required" : undefined
              }
            >
              <SidebarList>
                <p className={styles.connectionMessage}>
                  {connection.status === "connecting"
                    ? "Connecting to your relay…"
                    : (connection.error ??
                      "Choose a community to see channels.")}
                </p>
                {connection.status === "error" && (
                  <>
                    <CommunitySignIn
                      identity={props.federatedIdentity}
                      error={connection.error}
                      retry={props.relay.retry}
                    />
                    <Button onClick={props.relay.retry}>Retry channels</Button>
                  </>
                )}
              </SidebarList>
            </SidebarFrame>
          </div>
        )}
      </SidebarBoundary>
    </NavigationDensity>
  );
}

/** A protected community can refuse after its channel list is shown: native
 * discovery hands back the transport before NIP-FI admission, so the refusal
 * arrives on the live socket. Its recovery reconnects only that socket. */
function LiveSignIn({
  session,
  identity,
}: {
  session: RelaySession;
  identity: FederatedIdentity | undefined;
}) {
  const live = useSyncExternalStore(
    session.live.subscribe,
    session.live.snapshot,
    session.live.snapshot,
  );
  if (live.status !== "error") return null;
  return (
    <CommunitySignIn
      identity={identity}
      error={live.error}
      retry={session.live.retry}
    />
  );
}
