import { useRef, useState } from "react";
import type { PluginInfo } from "../plugins/types";
import type { PluginManager } from "../plugins/manager";
import { DotsThreeIcon } from "../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../shared/design-system/ui/Menu";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Button } from "../shared/design-system/ui/Button";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { PluginAccessReview } from "./PluginAccessReview";

export function PluginMenu({
  plugin,
  plugins,
  busy,
  label = "More plugin actions",
  toggle,
  onRemoved,
}: {
  plugin: PluginInfo;
  plugins: PluginManager;
  busy: boolean;
  label?: string;
  onRemoved?: () => void;
  toggle?: { label: string; disabled: boolean; run(): void };
}) {
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          render={
            <IconButton
              ref={deleteTrigger}
              aria-label={label}
              size="sm"
              disabled={busy}
              icon={<DotsThreeIcon size={16} aria-hidden="true" />}
            />
          }
        />
        <MenuPopup
          align="end"
          aria-label="Plugin actions"
          finalFocus={confirmDelete || showAccess ? false : deleteTrigger}
        >
          <MenuItem onClick={() => setShowAccess(true)}>Review access</MenuItem>
          {toggle && (
            <MenuItem disabled={toggle.disabled} onClick={toggle.run}>
              {toggle.label}
            </MenuItem>
          )}
          {plugin.source === "external" && plugin.previous && (
            <MenuItem
              disabled={busy || !!plugin.rollbackBlockedReason}
              onClick={() => plugins.change("rollback", plugin.manifest.id)}
            >
              Roll back
            </MenuItem>
          )}
          {plugin.source === "external" && (
            <MenuItem
              tone="danger"
              disabled={busy}
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            >
              Delete
            </MenuItem>
          )}
        </MenuPopup>
      </MenuRoot>
      <Dialog
        open={showAccess}
        onOpenChange={setShowAccess}
        title="What this plugin can do"
        finalFocus={deleteTrigger}
        actions={<Button onClick={() => setShowAccess(false)}>Done</Button>}
      >
        <PluginAccessReview manifest={plugin.manifest} />
      </Dialog>
      {confirmDelete && (
        <AlertDialog
          title={`Delete ${plugin.manifest.name}?`}
          description="Removes this plugin and its rollback history from Buzz. You can install it again later."
          pending={busy || deleting}
          finalFocus={deleteTrigger}
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Button
                disabled={busy || deleting}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || deleting}
                onClick={async () => {
                  if (busy || deleting) return;
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    if (await plugins.change("remove", plugin.manifest.id)) {
                      setConfirmDelete(false);
                      onRemoved?.();
                    } else
                      setDeleteError(
                        plugins.snapshot().error ??
                          "Plugin deletion wasn’t confirmed. Try again.",
                      );
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                Delete plugin
              </Button>
            </>
          }
        >
          {deleteError && (
            <p role="alert" className="error text-body-sm">
              {deleteError}
            </p>
          )}
        </AlertDialog>
      )}
    </>
  );
}
