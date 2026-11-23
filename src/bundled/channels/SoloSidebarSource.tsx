import { useContext } from "react";
import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import {
  MessagesSidebarEnvironment,
  type MessagesSidebarState,
} from "./sidebar-environment";
import type { SidebarSectionSource } from "../../features/channel-navigation/sidebar-section-components";
import { SoloInventory } from "./SoloInventory";
import { SoloRegions, visibleSoloRegions } from "./SoloRegions";

/** One region's card. Only the region that composes chats needs the Solo
 * inventory around it. */
function SoloSidebarContents({
  region,
  ...props
}: MessagesSidebarState & { region: string }) {
  const { regions } = useSoloNavigation(props.session);
  const composing =
    visibleSoloRegions(regions).find((item) => item.source)?.key === region;
  if (!composing || !props.workspaceComposition.sections.size)
    return (
      <SoloRegions
        session={props.session}
        scope={props.scope}
        navigator={props.navigator}
        target={props.target}
        sidebar={props.sidebar}
        pendingClick={props.workspaceComposition.pendingChatClick}
        only={region}
      />
    );
  return (
    <SoloInventory
      session={props.session}
      scope={props.scope}
      navigator={props.navigator}
      target={props.target}
      chatIcons={props.chatIcons}
      chatMenus={props.chatMenus}
      sidebarRows={props.sidebarRows}
      workspaceComposition={props.workspaceComposition}
      renderContents={(_ordinary, _header, pendingClick, composeOrdinary) => (
        <SoloRegions
          session={props.session}
          scope={props.scope}
          navigator={props.navigator}
          target={props.target}
          sidebar={props.sidebar}
          composeOrdinary={composeOrdinary}
          pendingClick={pendingClick}
          only={region}
        />
      )}
    />
  );
}
export const soloSidebarSource: SidebarSectionSource = {
  version: 2,
  id: "solo",
  context: "buzz.channels/messages",
  scope: "solo",
  component: function SoloSidebarSource({ render }) {
    const environment = useContext(MessagesSidebarEnvironment);
    if (!environment)
      throw new Error("Solo navigation requires its Messages context");
    const { regions } = useSoloNavigation(environment.session);
    // Each region is a card of its own in the sidebar's one card order.
    return render(
      visibleSoloRegions(regions).map((region, index) => ({
        id: `solo-region:${region.key}`,
        title: region.title,
        defaultPosition: index,
        element: <SoloSidebarContents {...environment} region={region.key} />,
      })),
    );
  },
};
