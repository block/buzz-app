import { communityDestination } from "../../features/communities/destination";
import { nativeRelayStaff } from "../../features/relay-staff/native";
import type { PluginModule } from "../../plugins/api";
import { ShieldIcon } from "../../shared/design-system/icons";
import { RelayStaff } from "./RelayStaff";
import { createStaff } from "./staff";

export const inject = ["settingsCards", "communityReader"];
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
    component: ({ active }) => <RelayStaff staff={staff} active={active} />,
  });
};
