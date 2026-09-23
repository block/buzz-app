// FOUNDATION: Compose the bundled distribution, plugin runtime, and services here.
import { IdentityNamesService } from "../features/identity-names/service";
import { bindAgentMentions } from "../features/agents/mention-wake";
import { provideAgentControl } from "../features/agents/control-service";
import { bindUnreadIndicator } from "../features/notifications/indicator-unread";
import { provideNavigation } from "../features/navigation/service";
import { NotificationsService } from "../features/notifications/service";
import {
  bindMessageNotifications,
  notificationAuthorized,
} from "../features/notifications/messages";
import { ShortcutsService } from "../features/shortcuts/service";
import { ConversationService } from "../features/conversation/service";
import { createAppearance } from "../shared/theme/service";
import { createCommunities } from "../features/communities/service";
import { PanelsService } from "../features/panels/service";
import { Context } from "@deepseek-ai/cordis";
import { PagesService } from "../features/pages/service";
import { bundledPlugins } from "../bundled";
import { createPluginManager } from "../plugins/manager";
import { withTimeout } from "../plugins/timeout";

export function createServices() {
  const appearance = createAppearance();
  const ctx = new Context();
  const plugins = createPluginManager(ctx, {
    bundled: bundledPlugins,
  });
  const agentControl = provideAgentControl(ctx);
  const navigationHost = provideNavigation(ctx);
  const navigation = navigationHost.navigation;
  const shortcuts = new ShortcutsService(ctx);
  const pages = new PagesService(ctx);
  const panels = new PanelsService(ctx);
  const conversation = new ConversationService(ctx);
  const identityNames = new IdentityNamesService(ctx);
  const communities = createCommunities(
    ctx,
    import.meta.env.VITE_BUZZ_LIVE === "1",
    identityNames,
    import.meta.env.VITE_BUZZ_OPEN_RELAY ?? "",
  );
  const relay = communities.relay;
  ctx.effect(() => bindAgentMentions(agentControl, communities));
  const notifications = new NotificationsService(
    ctx,
    navigation,
    undefined,
    undefined,
    (target) => notificationAuthorized(communities, target),
  );
  ctx.effect(() => bindMessageNotifications(notifications, communities));
  if (notifications.indicator.available)
    ctx.effect(() =>
      bindUnreadIndicator(communities, notifications.indicator.setUnread),
    );
  let disposal: Promise<void> | undefined;
  return {
    agentControl,
    notifications,
    navigation,
    navigationHost,
    shortcuts,
    conversation,
    pages,
    panels,
    plugins,
    relay,
    communities,
    appearance,
    dispose() {
      appearance.dispose();
      // Start root cancellation without waiting for plugin-owned cleanup. Cordis
      // starts sibling effects independently; the runtime still owns replacement
      // barriers. A timeout reports incomplete cleanup, never successful disposal.
      disposal ??= withTimeout(
        Promise.all([plugins.dispose(), ctx.fiber.dispose()]),
        "App cleanup timed out; restart the app",
      ).then(() => {});
      return disposal;
    },
  };
}

export type AppServices = ReturnType<typeof createServices>;
