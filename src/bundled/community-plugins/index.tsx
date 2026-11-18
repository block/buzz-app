import type { PluginModule } from "../../plugins/api";
import type { PluginInstaller } from "../../plugins/installer";
import { loadIndex } from "./catalog";
import { communityIndexUrl, listingRepository } from "./config";
import { CommunityPluginsPage } from "./CommunityPluginsPage";
import { createRecorder } from "./recorder";

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
  // Where the page can't browse, its switch isn't shown, so nothing is recorded.
  const recorder =
    indexUrl && host
      ? createRecorder({
          relay: ctx.relay,
          listed: listedIds(host, indexUrl),
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
        installer={installer}
        relay={ctx.relay}
        recorder={recorder}
        openPluginSettings={openPluginSettings}
      />
    ),
  });
};

const LISTED_TTL_MS = 10 * 60_000;

/** The index's manifest ids, read again after a while; a failed read isn't kept. */
function listedIds(host: Parameters<typeof loadIndex>[0], url: string) {
  let cached: { at: number; ids: Promise<ReadonlySet<string>> } | undefined;
  return () => {
    if (!cached || Date.now() - cached.at > LISTED_TTL_MS) {
      const ids = loadIndex(host, url).then(
        (index) => new Set(index.plugins.map((plugin) => plugin.id)),
      );
      const entry = { at: Date.now(), ids };
      cached = entry;
      ids.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached.ids;
  };
}
