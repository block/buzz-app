import {
  AlarmIcon,
  BellIcon,
  BrowserIcon,
  ChatsCircleIcon,
  NoteIcon,
  GearIcon,
  LightningIcon,
  RobotIcon,
  SendIcon,
} from "../../shared/design-system/icons/index";
import type { RegisteredPage } from "../../features/pages/service";

// Shell-owned presentation keeps plugin content independent of navigation chrome.
// Add page identities here; unknown plugins inherit a consistent layout default.
export const shellPresentation = {
  settings: { label: "Settings", icon: GearIcon, tone: "lavender" },
  channels: { label: "Messages", icon: ChatsCircleIcon, tone: "lime" },
} as const;

// Navigation order is host policy, never plugin activation timing. Match full
// contribution keys so an external page's local ID cannot claim a bundled slot.
const bundledOrder = [
  "buzz.channels/channels",
  "buzz.inbox/inbox",
  "buzz.drafts-and-sent/drafts-sent",
  "buzz.reminders/reminders",
  "buzz.bestie/bestie",
];
const dockOrder = [
  "buzz.bestie/bestie",
  "buzz.channels/channels",
  "buzz.reminders/reminders",
];
export function orderPages(
  pages: readonly RegisteredPage[],
  location: "default" | "dock" = "default",
) {
  const order = location === "dock" ? dockOrder : bundledOrder;
  const rank = (page: RegisteredPage) => {
    const slot = order.indexOf(page.key);
    return slot === -1 ? order.length : slot;
  };
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      pagePresentation(a).label.localeCompare(
        pagePresentation(b).label,
        "en",
      ) ||
      a.key.localeCompare(b.key, "en"),
  );
}

const bundledIcons = new Map<string, typeof BrowserIcon>([
  ["buzz.inbox/inbox", BellIcon],
  ["buzz.drafts-and-sent/drafts-sent", SendIcon],
  ["buzz.reminders/reminders", AlarmIcon],
  ["buzz.agents/agents", RobotIcon],
  ["buzz.workflows/workflows", LightningIcon],
  ["buzz.relay-notes/notes", NoteIcon],
  ["com.squareup.docs/docs", NoteIcon],
]);
/** The plugins pinned to the sidebar's Plugins card, in the person's order.
 * Before they ever choose, the built-in plugins' pages are the pins, in
 * navigation order; undefined while it isn't known which plugins are built in. */
export function resolvePluginPins(
  saved: readonly string[] | undefined,
  pages: readonly RegisteredPage[],
  builtIn: ((pluginId: string) => boolean) | undefined,
): readonly string[] | undefined {
  if (saved) return saved;
  if (!builtIn) return undefined;
  return [
    ...new Set(
      orderPages(pages)
        .filter((page) => builtIn(page.pluginId))
        .map((page) => page.pluginId),
    ),
  ];
}

/** Pins A–Z by their page's label; pins without a page here (off or not
 * installed) keep their saved order after them. */
export function sortPinsByLabel(
  pins: readonly string[],
  pages: readonly RegisteredPage[],
): readonly string[] {
  const labels = new Map<string, string>();
  for (const page of pages)
    if (!labels.has(page.pluginId))
      labels.set(page.pluginId, pagePresentation(page).label);
  const shown = pins.filter((id) => labels.has(id));
  shown.sort(
    (a, b) =>
      (labels.get(a) ?? "").localeCompare(labels.get(b) ?? "", undefined, {
        sensitivity: "base",
      }) || a.localeCompare(b),
  );
  return [...shown, ...pins.filter((id) => !labels.has(id))];
}

/** The card's rows: pinned plugins' pages in pin order, then the open page
 * while it isn't pinned, so the open destination always shows. Without pins,
 * every page. */
export function pinnedPages(
  pages: readonly RegisteredPage[],
  pins: readonly string[] | undefined,
  selected: string,
) {
  const ordered = orderPages(pages);
  if (!pins) return ordered;
  const rank = new Map(pins.map((id, index) => [id, index]));
  const pinned = ordered
    .filter((page) => rank.has(page.pluginId))
    .sort((a, b) => (rank.get(a.pluginId) ?? 0) - (rank.get(b.pluginId) ?? 0));
  const open = ordered.find(
    (page) => page.key === selected && !rank.has(page.pluginId),
  );
  return open ? [...pinned, open] : pinned;
}

/** Resolve host navigation policy once, independently of icons and registrations. */
export function pagePlacement(page: RegisteredPage) {
  if (!page.primary) return undefined;
  // Every app is a row in the Messages sidebar's Plugins card; there is no
  // separate dock. Messages itself is the sidebar, so it needs no row.
  return page.key === "buzz.channels/channels" ? "dock" : "sidebar";
}

/** The app whose navigation lists a destination: the dock selects it and the
 * shell shows its sidebar unless the page supplies its own. Pages listed in
 * the Messages sidebar belong to Messages while it is registered;
 * conversations already select the Messages page. Every other destination,
 * including Settings and unlisted pages, owns itself. */
export function navigationOwner(
  pages: readonly RegisteredPage[],
  selected: string,
) {
  const messages = "buzz.channels/channels";
  const page = pages.find((page) => page.key === selected);
  return page &&
    (page.conversationNavigation || pagePlacement(page) === "sidebar") &&
    pages.some((page) => page.key === messages)
    ? messages
    : selected;
}

type PagePresentation = Readonly<{
  label: string;
  icon: typeof BrowserIcon;
  tone: string;
  image?: string;
}>;
export function pagePresentation(page: RegisteredPage): PagePresentation {
  if (page.key === "buzz.channels/channels") return shellPresentation.channels;
  const tone = page.layout === "workspace" ? "lime" : "sky";
  const bundledIcon = bundledIcons.get(page.key);
  if (bundledIcon) return { label: page.title, icon: bundledIcon, tone };
  return {
    label: page.title,
    icon: BrowserIcon,
    tone,
    ...(page.icon === undefined ? {} : { image: page.icon }),
  };
}

/** Visibility compatibility for callers of AppShell predating registered sidebar contexts. */
export function legacySidebarAvailable(
  pages: readonly RegisteredPage[],
  selected: string,
) {
  return (
    navigationOwner(pages, selected) === "buzz.channels/channels" ||
    pages.some((page) => page.key === selected && !!page.sidebar)
  );
}
