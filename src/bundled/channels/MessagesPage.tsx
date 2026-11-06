import type { ComponentProps } from "react";
import { DraftsSentPage } from "../../features/drafts-sent/DraftsSentPage";
import { ChannelsPage } from "./ChannelsPage";

/** Messages owns both conversation destinations and the community's drafts/sent view. */
export function MessagesPage(props: ComponentProps<typeof ChannelsPage>) {
  const draftsSent =
    props.navigation?.target.kind === "page" &&
    props.navigation.target.route?.params === "drafts-sent";
  return draftsSent ? (
    <DraftsSentPage
      panels={props.panels}
      extensions={props.extensions}
      relay={props.relay}
      navigator={props.navigator}
      navigation={props.navigation}
      companion={props.companion}
    />
  ) : (
    <ChannelsPage {...props} />
  );
}
