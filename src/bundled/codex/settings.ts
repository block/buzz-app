// The agent settings that sync across devices (NIP-AP `buzz.agent.settings`):
// every per-agent setting except instructions, which have their own artifact.
// No credentials or env vars live in this config; the allowlist keeps it so.
import {
  pickSettings,
  type SettingsSchema,
  withSynced,
} from "../../features/agents/agent-config";
import { type Config, defaults } from "./config";

export const syncedSettingsSchema = {
  voice: "string",
  model: "string",
  effort: "string",
  scope: ["thread", "channel"],
} as const satisfies SettingsSchema;

export const syncedSettings = (config: Config) => {
  const settings = pickSettings(syncedSettingsSchema, config);
  // Unset voices retain the settings shape older clients already understand.
  if (!settings.voice) delete settings.voice;
  return settings;
};

/** Synced fields come only from `settings`, a left-out one from the default;
 * everything else stays this device's. */
export const withSyncedSettings = (
  config: Config,
  settings: Readonly<Record<string, string>>,
): Config => withSynced(syncedSettingsSchema, defaults, config, settings);
