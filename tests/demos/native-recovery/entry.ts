import { mockIPC } from "@tauri-apps/api/mocks";

declare global {
  interface Window {
    recordingInvoke(command: string, payload?: unknown): Promise<unknown>;
    recordingAliases: string;
  }
}

const config = (await window.recordingInvoke("fixture_config")) as {
  aliases: Record<string, string>;
};
window.recordingAliases = JSON.stringify(config.aliases);
mockIPC(async (command, payload) => {
  if (command === "plugin_catalog") {
    const { bundledPlugins } = await import("../../../src/bundled");
    return {
      status: "ready",
      externalPluginsPaused: false,
      catalog: {
        profile: "recording",
        location: "Isolated browser fixture",
        plugins: bundledPlugins.map(
          ({ manifest, enabledByDefault = true }) => ({
            manifest,
            enabled: enabledByDefault,
            source: "bundled",
            revision: "bundled",
            previous: null,
            reloadable: false,
            error: null,
          }),
        ),
      },
    };
  }
  return window.recordingInvoke(command, payload);
});
// Load the unchanged application only after the fixture IPC/configuration exists.
await import("../../../src/main");
