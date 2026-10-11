import type { Plugin } from "vite";

/** Keep native installs offline-capable without shipping the other engine's codec. */
export function avatarCodecs(platform: string | undefined): Plugin {
  const excluded =
    platform === "macos"
      ? "webm"
      : platform === "windows" || platform === "linux"
        ? "mp4"
        : undefined;
  const empty = "\0unused-avatar-codec";
  return {
    name: "avatar-codecs",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        excluded &&
        importer
          ?.replaceAll("\\", "/")
          .endsWith("/features/agents/avatar-packs.ts") &&
        source.replaceAll("\\", "/").includes("/avatar-packs/") &&
        source.split("?")[0]?.endsWith(`.${excluded}`)
      )
        return empty;
    },
    load(id) {
      if (id === empty) return "export default undefined;";
    },
  };
}
