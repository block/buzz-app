import {
  SquaresFourIcon,
  UserIcon,
  PaletteIcon,
  BellIcon,
  ChatCircleIcon,
  KeyboardIcon,
  PlugIcon,
  WrenchIcon,
} from "../shared/design-system/icons/index";

type Section = { id: string; label: string; icon: typeof UserIcon };

// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too.
export const developerMode =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

const baseSections: Section[] = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "plugins", label: "Plugins", icon: SquaresFourIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "messages", label: "Messages", icon: ChatCircleIcon },
  { id: "notifications", label: "Notifications", icon: BellIcon },
  { id: "builderlab", label: "BuilderLab", icon: PlugIcon },
];

export const settingsSections: Section[] = developerMode
  ? [...baseSections, { id: "developer", label: "Developer", icon: WrenchIcon }]
  : baseSections;

export function isSettingsSectionId(value: string): boolean {
  return settingsSections.some((section) => section.id === value);
}
