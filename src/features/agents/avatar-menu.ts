import type { HTMLAttributes } from "react";

/** Agent portraits identify a profile or destination, not downloadable media.
 * Cancel the native image menu and keep menu keys from reaching a parent row. */
export const agentAvatarMenuProps: Pick<
  HTMLAttributes<HTMLElement>,
  "onContextMenu" | "onKeyDown"
> = {
  onContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
  },
  onKeyDown(event) {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
};
