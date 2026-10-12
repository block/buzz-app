import { createDeviceToggle } from "../../shared/device-toggle";

const rememberMentionedAgents = createDeviceToggle({
  storageKey: "buzz-remember-mentioned-agents.v1",
  enabledByDefault: true,
});

export const rememberAgentsPreference = rememberMentionedAgents.isEnabled;
export const useRememberAgentsPreference = rememberMentionedAgents.useEnabled;
export const setRememberAgentsPreference = rememberMentionedAgents.setEnabled;
