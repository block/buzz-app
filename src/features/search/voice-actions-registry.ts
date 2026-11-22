// Combined voice-action registry for the live app.
// Additional domain modules (sidebar/people/message/thread) register here.
import {
  matchActionBindings,
  type VoiceActionBinding,
  type VoiceSlotEntities,
} from "./voice-actions";
import type { AppVoiceAction, VoiceActionContext } from "./voice-actions-app";
import { channelVoiceActions } from "./voice-actions-channel";
import { messageVoiceActions } from "./voice-actions-message";
import { peopleVoiceActions } from "./voice-actions-people";
import { sidebarVoiceActions } from "./voice-actions-sidebar";
import { quickMessageVoiceActions } from "./voice-actions-message-quick";

export const VOICE_ACTIONS: readonly AppVoiceAction[] = [
  ...channelVoiceActions,
  ...sidebarVoiceActions,
  ...peopleVoiceActions,
  ...messageVoiceActions,
  ...quickMessageVoiceActions,
];

export function matchSessionActionBindings(
  actions: readonly AppVoiceAction[],
  ctx: VoiceActionContext,
  entities: VoiceSlotEntities,
): VoiceActionBinding<AppVoiceAction>[] {
  return matchActionBindings(actions, ctx.hovered, entities, (action, role) =>
    action.available ? action.available(ctx, role) : true,
  );
}
