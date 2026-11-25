import type { RefObject } from "react";
import { PlusIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuItem } from "../../shared/design-system/ui/Menu";

/** A workspace's +: every conversation in it starts in New message. Inside
 * the workspace's own menu it's that menu's New message item. */
export function WorkspaceNewMenu({
  name,
  available,
  menuAnchor,
  start,
}: {
  name: string;
  available: boolean;
  menuAnchor?: RefObject<HTMLButtonElement | null> | undefined;
  start: () => void;
}) {
  if (menuAnchor)
    return (
      <MenuItem disabled={!available} onClick={start}>
        New message
      </MenuItem>
    );
  const label = `New message in ${name}`;
  return (
    <IconButton
      disabled={!available}
      aria-label={label}
      title={label}
      variant="ghost"
      size="sm"
      icon={<PlusIcon aria-hidden="true" />}
      onClick={start}
    />
  );
}
