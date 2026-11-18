import type { PluginModule } from "../../plugins/api";
import type { PluginInstaller } from "../../plugins/installer";
import { communityIndexUrl, listingRepository } from "./config";
import { CommunityPluginsPage } from "./CommunityPluginsPage";
import { indexSource } from "./index-source";
import { createRecorder } from "./recorder";
import { relayRecordingDefault } from "./relay-default";

export const inject = [
  "pages",
  "navigation",
  "host",
  "relay",
  "pluginInventory",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const indexUrl = communityIndexUrl();
  const host = ctx.host?.canRequest?.() === false ? undefined : ctx.host;
  const installer = ctx.reflect.get("pluginInstaller") as
    | PluginInstaller
    | undefined;
  const inventory = ctx.pluginInventory;
  const index = indexUrl && host ? indexSource(host, indexUrl) : undefined;
  // Where the page can't browse, its switch isn't shown, so nothing is recorded.
  const recorder = index
    ? createRecorder({
        relay: ctx.relay,
        listed: index.listed,
        relayDefault: (session) => relayRecordingDefault(session.scope),
        inventory: {
          installed: () => inventory.installed(),
          subscribe: (listener) => inventory.subscribe(listener),
        },
      })
    : undefined;
  if (recorder) ctx.effect(() => () => recorder.stop());
  const openPluginSettings = () =>
    void ctx.navigation.open({
      version: 1,
      kind: "settings",
      section: "plugins",
    });
  ctx.pages.register({
    id: "community-plugins",
    title: "Community plugins",
    layout: "workspace",
    primary: true,
    component: () => (
      <CommunityPluginsPage
        indexUrl={indexUrl}
        listingRepository={listingRepository(indexUrl)}
        host={host}
        readIndex={index?.read}
        installer={installer}
        relay={ctx.relay}
        recorder={recorder}
        openPluginSettings={openPluginSettings}
      />
    ),
  });
};
