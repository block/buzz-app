import { createContext, useContext } from "react";
import type { SeenStore } from "../../shared/design-system/ui/EducationHint";

/** The host's Seen service, when it has one, for the sidebar's one-time tips. */
export const SeenContext = createContext<SeenStore | undefined>(undefined);

export const useSeen = () => useContext(SeenContext);

/** Set once the sidebar tour is answered or closed. A later release uses a new
 * key so the tour shows once more. */
export const sidebarTourKey = "buzz.channels/sidebar-tour-workspaces-1";
/** Set when the person keeps every card full rather than trimming them. */
export const stayMessyKey = "buzz.channels/sidebar-stay-messy";
