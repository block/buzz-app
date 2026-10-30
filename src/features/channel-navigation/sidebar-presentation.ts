import { createContext, useContext } from "react";

/** Project children indent; pinned and unfiled rows align with their headings. */
export const SidebarRowInset = createContext(false);
export const useSidebarRowInset = () => useContext(SidebarRowInset);
