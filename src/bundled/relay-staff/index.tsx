import { communityDestination } from "../../features/communities/destination";
import { nativeRelayStaff } from "../../features/relay-staff/native";
import type { PluginModule } from "../../plugins/api";
import { ShieldIcon } from "../../shared/design-system/icons";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { ProfilesContext } from "./people";
import { RelayStaff } from "./RelayStaff";
import { createStaff } from "./staff";

export const inject = ["relay", "settingsCards", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  const reader = ctx.communityReader;
  const staff = createStaff(nativeRelayStaff(), () => {
    const { selected, viewer } = reader.snapshot();
    if (!selected || !viewer) return null;
    try {
      return { relay: communityDestination(selected).url, signer: viewer };
    } catch {
      return null;
    }
  });
  ctx.effect(() => reader.subscribe(staff.refresh));
  ctx.settingsCards.register({
    id: "console",
    title: "Relay staff",
    icon: ShieldIcon,
    section: "administration",
    visibility: {
      snapshot: staff.visible,
      subscribe: staff.subscribe,
      ensure: staff.ensure,
    },
    component: ({ active }) => (
      <WithProfiles relay={ctx.relay}>
        <RelayStaff staff={staff} active={active} />
      </WithProfiles>
    ),
  });
};

/** Names come from the connected community's profiles; reconnecting replaces them. */
function WithProfiles({
  relay,
  children,
}: {
  relay: RelayData;
  children: React.ReactNode;
}) {
  const { session } = useRelayConnection(relay);
  return (
    <ProfilesContext.Provider value={session.profiles}>
      {children}
    </ProfilesContext.Provider>
  );
}
