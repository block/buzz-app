import { createContext, type ReactNode, useContext } from "react";
import styles from "./SidebarToolbar.module.css";

/** The shell supplies one creation/search owner to its current sidebar. */
export const SidebarToolbarContent = createContext<ReactNode>(null);
export function SidebarToolbar() {
  const content = useContext(SidebarToolbarContent);
  return content ? <div className={styles.toolbar}>{content}</div> : null;
}
