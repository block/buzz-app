import type { SidebarSectionRow } from "../../features/channel-navigation/sidebar-sections-service";
import type { PluginModule } from "../../plugins/api";
import { BellSlashIcon } from "../../shared/design-system/icons/index";
import { hideMutedRows, mutedRows } from "./muted";

export const inject = ["relay"];

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.reflect.get("sidebarRows")?.register(hideMutedRows(relay));
  ctx.reflect.get("sidebarSections")?.register({
    version: 1,
    id: "muted",
    title: "Muted",
    icon: <BellSlashIcon size={16} aria-hidden="true" />,
    rows: mutedRows(relay),
    select: (row: SidebarSectionRow) => {
      const { origin, viewer } = relay.snapshot();
      return origin && viewer
        ? {
            version: 1,
            kind: "conversation",
            channelId: row.id,
            scope: { viewer, communityOrigin: origin },
          }
        : { version: 1, kind: "home" };
    },
  });
};
