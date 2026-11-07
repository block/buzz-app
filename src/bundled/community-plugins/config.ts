import type { PluginManifest } from "../../plugins/api";

const GITHUB_API = "https://api.github.com";

/** The build's community plugin index URL, or empty when it has none. */
export function communityIndexUrl(): string {
  return import.meta.env.VITE_BUZZ_COMMUNITY_PLUGIN_INDEX_URL ?? "";
}

/** The GitHub repository that lists plugins, `owner/repo`, when the index is
 * published from one on raw.githubusercontent.com. */
export function listingRepository(indexUrl: string): string | undefined {
  const match =
    /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\//.exec(
      indexUrl,
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Keep in step with `bundled_manifests` in crates/plugin-manager/src/lib.rs. */
export function communityPluginsAccess(
  indexUrl: string,
): Pick<PluginManifest, "host"> {
  if (!indexUrl) return {};
  const origin = new URL(indexUrl).origin;
  return {
    host: {
      networkOrigins:
        origin === GITHUB_API ? [GITHUB_API] : [origin, GITHUB_API],
    },
  };
}
