import type { ReactNode } from "react";

/** One plugin as the All plugins popover shows it: a plugin that is on and has
 * a page. The host builds these; the popover owns layout and sorting only. */
export type AllPluginsEntry = {
  /** The plugin id, such as `buzz.reminders`. */
  key: string;
  label: string;
  /** Rendered by the host from the plugin's page. */
  icon: ReactNode;
  /** Pinned entries arrive in the person's order. */
  pinned: boolean;
  /** Its page is the one currently open. */
  active: boolean;
};

export type AllPluginsProps = {
  plugins: readonly AllPluginsEntry[];
  onOpen: (key: string) => void;
  onPinnedChange: (key: string, pinned: boolean) => void;
  /** The complete pinned order after a move. */
  onPinnedOrderChange: (keys: readonly string[]) => void;
  /** How pinned plugins are ordered; moving one makes it custom. */
  sort: "alphabetical" | "custom";
  onSortChange: (sort: "alphabetical" | "custom") => void;
};
