import type { SettingsGroup } from "./settings-sections";

export type SettingSearchEntry = {
  section: string;
  id: string;
  label: string;
  keywords: string;
  /** A prerequisite to show when the dependent control is not rendered. */
  fallback?: string;
  hint?: string;
};

// Static presentation metadata only: never index saved values, credentials, or
// the contents of plugin components. Section visibility comes from SettingsCards.
export const settingSearchEntries: readonly SettingSearchEntry[] = [
  {
    section: "appearance",
    id: "setting-mode",
    label: "Mode",
    keywords: "theme color light dark system",
  },
  {
    section: "appearance",
    id: "setting-interface-size",
    label: "Interface size",
    keywords: "font text zoom scale accessibility",
  },
  {
    section: "appearance",
    id: "setting-accent",
    label: "Accent color",
    keywords: "colour theme",
  },
  {
    section: "appearance",
    id: "setting-vibe",
    label: "Vibe level",
    keywords: "contrast buzzin",
  },
  {
    section: "appearance",
    id: "setting-clock",
    label: "Clock",
    keywords: "time format 12 24 hour",
  },
  {
    section: "appearance",
    id: "setting-seconds",
    label: "Show seconds",
    keywords: "clock time",
  },
  {
    section: "appearance",
    id: "setting-time-zone-details",
    label: "Show time zone details on profiles",
    keywords: "timezone local time",
  },
  {
    section: "appearance",
    id: "setting-density",
    label: "Message density",
    keywords: "compact conversations layout",
  },
  {
    section: "appearance",
    id: "setting-width",
    label: "Message width",
    keywords: "wide narrow conversations",
    fallback: "setting-density",
    hint: "Available with Default message density",
  },
  {
    section: "appearance",
    id: "setting-timestamps",
    label: "Message timestamps",
    keywords: "time hide solo",
  },
  {
    section: "appearance",
    id: "setting-names",
    label: "Show people by",
    keywords: "username full name",
    hint: "Available in communities with verified names",
  },
  {
    section: "appearance",
    id: "setting-follow-up",
    label: "Follow-up behavior",
    keywords: "solo queue send immediately",
  },
  {
    section: "appearance",
    id: "setting-threads",
    label: "Open threads in",
    keywords: "main side pane placement",
  },
  {
    section: "appearance",
    id: "setting-autocorrect",
    label: "Allow automatic spelling correction",
    keywords: "autocorrect macos",
    hint: "Available in Mac WebKit",
  },
  {
    section: "appearance",
    id: "setting-unread-first",
    label: "Show unread first in search",
    keywords: "channels direct messages",
  },
  {
    section: "appearance",
    id: "setting-search-sort",
    label: "Sort messages by",
    keywords: "search order recent relevant",
  },
  {
    section: "notifications",
    id: "notification-categories-title",
    label: "Notify me about",
    keywords: "mentions direct messages replies categories alerts",
  },
  {
    section: "notifications",
    id: "setting-desktop-alerts",
    label: "Desktop alerts",
    keywords: "enable disable notifications permission",
  },
  {
    section: "notifications",
    id: "setting-viewing",
    label: "Notify while viewing",
    keywords: "direct messages conversation alerts",
    fallback: "setting-desktop-alerts",
    hint: "Requires Desktop alerts",
  },
  {
    section: "notifications",
    id: "setting-sound",
    label: "Sound",
    keywords: "audio mute notification sounds",
    fallback: "setting-desktop-alerts",
    hint: "Requires Desktop alerts",
  },
  {
    section: "notifications",
    id: "setting-dock-badge",
    label: "Dock unread badge",
    keywords: "dot macos permission",
    hint: "Available in the macOS app",
  },
  {
    section: "agents",
    id: "setting-remember-agents",
    label: "Remember mentioned agents",
    keywords: "selection channel thread",
  },
  {
    section: "agents",
    id: "setting-keep-awake",
    label: "Keep this Mac awake",
    keywords: "sleep power agents",
    hint: "Available in the macOS app",
  },
  {
    section: "agents",
    id: "setting-awake-after",
    label: "Stay awake after agents finish",
    keywords: "sleep delay power",
    fallback: "setting-keep-awake",
    hint: "Available while agents work on macOS",
  },
  {
    section: "local-settings",
    id: "setting-community-name",
    label: "Display name",
    keywords: "rename community local name",
  },
  {
    section: "local-settings",
    id: "setting-community-address",
    label: "Community address",
    keywords: "relay url connection",
  },
  {
    section: "local-settings",
    id: "setting-caches",
    label: "Cached data",
    keywords: "clear cache channels messages images media storage",
  },
  {
    section: "security",
    id: "paired-tools-title",
    label: "Paired command-line tools",
    keywords: "cli revoke access credentials",
  },
  {
    section: "security",
    id: "security-diagnostics-title",
    label: "Allow Safari Web Inspector",
    keywords: "debug diagnostics webview",
    hint: "Available in supported macOS builds",
  },
  {
    section: "developer",
    id: "setting-log-level",
    label: "Log level",
    keywords: "logging runtime diagnostics",
  },
  {
    section: "developer",
    id: "setting-import-finds",
    label: "What Import finds",
    keywords: "agent import simulated",
  },
  {
    section: "developer",
    id: "setting-new-community",
    label: "Show as a new community",
    keywords: "agent import simulated",
  },
];

export type SettingsSearchResult = {
  section: string;
  label: string;
  setting?: SettingSearchEntry;
};

export function searchSettings(
  groups: readonly SettingsGroup[],
  query: string,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text: string) =>
    words.every((word) => text.toLocaleLowerCase().includes(word));
  return groups.flatMap((group) =>
    group.sections.flatMap((section) => {
      const results: SettingsSearchResult[] = [];
      if (matches(`${group.label} ${section.label}`))
        results.push({ section: section.id, label: section.label });
      for (const setting of settingSearchEntries) {
        if (
          setting.section === section.id &&
          matches(`${section.label} ${setting.label} ${setting.keywords}`)
        )
          results.push({ section: section.id, label: section.label, setting });
      }
      return results;
    }),
  );
}

/** Called only after the existing navigation owner admits and opens a section. */
export function revealSetting(entry: SettingSearchEntry) {
  const visible = (id: string) => {
    const element = document.getElementById(id);
    // Base UI gives a Switch id to its hidden native input, not its visible control.
    const target =
      element?.closest<HTMLElement>(".buzz-preference-row") ?? element;
    return target && !target.closest('[hidden], [inert], [aria-hidden="true"]')
      ? target
      : null;
  };
  const target =
    visible(entry.id) ?? (entry.fallback ? visible(entry.fallback) : null);
  // Conditional/platform-specific controls may not exist. Land on the open
  // section rather than focusing a hidden control or changing a prerequisite.
  const row =
    target?.closest<HTMLElement>(".buzz-preference-row") ??
    target ??
    document.getElementById("settings-content") ??
    document.getElementById("main-content");
  if (!row || row.closest('[hidden], [inert], [aria-hidden="true"]')) return;
  row.scrollIntoView({ block: "center", behavior: "instant" });
  const selector =
    'input, textarea, button, [role="switch"], [role="combobox"]';
  const candidates = row.matches(selector)
    ? [row]
    : target
      ? [...row.querySelectorAll<HTMLElement>(selector)]
      : [];
  const control = candidates.find(
    (candidate) =>
      !candidate.matches(':disabled, [aria-disabled="true"]') &&
      !candidate.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
  if (!control) row.tabIndex = -1;
  (control ?? row).focus({ preventScroll: true });
}
