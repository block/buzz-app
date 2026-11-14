import { createContext } from "react";

/**
 * How an open side panel tells the shell it occupies a column, so the shell
 * lays out around it without searching the page for one.
 */
export const SidePanelPresence = createContext<{
  /** Returns the panel's leave. */
  opened(): () => void;
} | null>(null);
