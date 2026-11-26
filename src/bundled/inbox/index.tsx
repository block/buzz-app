import type { PluginModule } from "../../plugins/api";
import { InboxBadge } from "./InboxBadge";
import { InboxPage } from "./InboxPage";
import { InboxPreview } from "./InboxPreview";
import { inboxRouteTarget, isInboxRoute, type InboxRoute } from "./route";
import type { Context } from "@deepseek-ai/cordis";
import type { SidebarSectionBodyProps } from "../../features/channel-navigation/sidebar-sections-service";
import { BellIcon } from "../../shared/design-system/icons";
import { activityLayouts } from "./activity-layout";
import { ActivityCard } from "./ActivityCard";
import { ActivitySettings } from "./ActivitySettings";
import { createDisplay, showsCard, showsPage } from "./display";
export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "panels",
  "shortcuts",
  "settingsCards",
];
const empty: readonly never[] = Object.freeze([]);
/** The card shows its own contents, not rows. */
const noRows = Object.freeze({
  snapshot: () => empty,
  subscribe: () => () => {},
});
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  // Slack's chords for jumping to a filtered Activity view, including from the composer.
  const open = (
    id: string,
    title: string,
    key: string,
    order: number,
    params: InboxRoute,
  ) =>
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, mod: true, shift: true },
      order,
      allowInEditable: true,
      run: () => {
        void navigator.open(inboxRouteTarget(params));
      },
    });
  open("open-unread", "Open unread in Activity", "a", 20, {
    activity: "all",
    attention: "unread",
  });
  open("open-threads", "Open threads in Activity", "t", 30, {
    activity: "threads",
  });
  open("open-mentions", "Open mentions in Activity", "m", 40, {
    activity: "mentions",
  });
  open("open-dms", "Open DMs in Activity", "k", 50, { activity: "dms" });
  const registerPage = (scope: Context, primary: boolean) =>
    scope.pages.register({
      id: "inbox",
      title: "Activity",
      layout: "workspace",
      primary,
      route: { version: 1, validate: isInboxRoute },
      badge: () => <InboxBadge relay={relay} />,
      component: ({ navigation }) => (
        <InboxPage
          relay={relay}
          navigator={navigator}
          tabs={ctx.conversation.ui.Tabs}
          navigation={navigation}
        />
      ),
      preview: ({ close }) => (
        <InboxPreview relay={relay} navigator={navigator} close={close} />
      ),
    });
  const display = createDisplay();
  ctx.effect(() => () => display.dispose());
  // Each choice registers in its own scope, so changing it removes what it
  // no longer shows. The page stays registered for its shortcuts and links;
  // only its sidebar entry follows the choice.
  let shown: { dispose(): unknown } | undefined;
  let queue = Promise.resolve();
  // One change at a time: the last scope is gone before the next registers
  // the same page and card again.
  const show = () => {
    queue = queue.then(async () => {
      await shown?.dispose();
      shown = undefined;
      if (!active) return;
      shown = present(display.snapshot());
    });
  };
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  const present = (choice: ReturnType<typeof display.snapshot>) =>
    ctx.plugin((scope: Context) => {
      registerPage(scope, showsPage(choice));
      if (showsCard(choice))
        scope.reflect.get("sidebarSections")?.register({
          version: 1,
          id: "activity",
          title: "Activity",
          rows: noRows,
          select: () => inboxRouteTarget({}),
          layouts: activityLayouts,
          body: (props: SidebarSectionBodyProps) => (
            <ActivityCard {...props} relay={relay} navigator={navigator} />
          ),
        });
    });
  shown = present(display.snapshot());
  ctx.effect(() => display.subscribe(show));
  ctx.settingsCards.register({
    id: "activity",
    title: "Activity",
    group: "Plugins",
    icon: BellIcon,
    component: ({ active }) => (
      <ActivitySettings display={display} active={active} />
    ),
  });
};
