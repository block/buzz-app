import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppServices } from "../../app/services";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { splitPartition } from "../relay/partition";
import { openTemporaryChat } from "../solo/temporary-chat";
import {
  bindAgentCompletionNotifications,
  completionBody,
  completionSourceKey,
  completionTarget,
  completionTitle,
  completionToast,
  shouldShowForegroundCompletion,
} from "./agent-completions";
import { playNotificationSound, resolveCategorySound } from "./sound";

export function AgentCompletionNotifications({
  services,
}: {
  services: Pick<
    AppServices,
    "agentActivity" | "agents" | "communities" | "navigation" | "notifications"
  >;
}) {
  const notify = useToastNotification();
  useEffect(
    () =>
      bindAgentCompletionNotifications(services.agentActivity, {
        focused: () =>
          isTauri() ? getCurrentWindow().isFocused() : document.hasFocus(),
        active: () => {
          const entry = services.navigation.snapshot().entry.target;
          const relay = services.communities.relay.snapshot();
          const open =
            relay.status === "ready"
              ? openTemporaryChat(relay.session)
              : undefined;
          if (
            open &&
            entry.kind === "conversation" &&
            entry.channelId === open.source.channelId
          )
            return {
              version: 1,
              kind: "conversation",
              scope: entry.scope,
              channelId: open.chatId,
            };
          return entry;
        },
        target: (work) => completionTarget(work, splitPartition(work.scope)),
        desktop: (work, target) => {
          const name = agentName(services, work.agent);
          void services.notifications.admit(
            "agent",
            "Solo chat completions",
            {
              sourceKey: completionSourceKey(work),
              target,
            },
            () => true,
            () => true,
            () => ({
              title: completionTitle(name, work),
              body: completionBody(work),
            }),
          );
        },
        foreground: (work, target) => {
          const state = services.notifications.snapshot();
          const { preferences } = state;
          if (!shouldShowForegroundCompletion(state)) return;
          if (preferences.sound)
            playNotificationSound(
              resolveCategorySound(preferences.sounds, "agent"),
            );
          notify(
            completionToast(agentName(services, work.agent), work),
            work.state === "error" ? "error" : "success",
            {
              label: "View",
              onClick: () => void services.navigation.open(target),
            },
          );
        },
      }),
    [notify, services],
  );
  return null;
}

function agentName(
  services: Pick<AppServices, "agents">,
  pubkey: string,
): string {
  return (
    services.agents.local().agents.find((agent) => agent.pubkey === pubkey)
      ?.name ?? "Agent"
  );
}
