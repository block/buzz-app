import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { SplitButton } from "../../shared/design-system/ui/SplitButton";
import { DownloadIcon } from "../../shared/design-system/icons";
import type { Updates } from "./updates";

/** Top-bar restart action, shown while a downloaded update is ready, scheduled
 * for when agents are idle, or installing. */
export function UpdateAction({ updates }: { updates: Updates }) {
  const { state } = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  const working = useSyncExternalStore(
    updates.subscribe,
    updates.workingCount,
    updates.workingCount,
  );
  if (state !== "ready" && state !== "scheduled" && state !== "installing")
    return null;
  const label = actionLabel(state, working);
  const install = () => void updates.installAndRelaunch();
  const content = (
    <>
      <DownloadIcon size={16} />
      {state === "scheduled" ? "Scheduled" : "Update"}
    </>
  );
  // An app without agents has nothing to wait for. Otherwise the same split
  // button stays mounted from ready through installing, so focus stays on it.
  if (!updates.idleOptionAvailable())
    return (
      <Button
        type="button"
        size="sm"
        variant="prominent"
        aria-label={label}
        title={label}
        loading={state === "installing"}
        onClick={install}
      >
        {content}
      </Button>
    );
  return (
    <SplitButton
      size="sm"
      variant="prominent"
      aria-label={label}
      title={label}
      loading={state === "installing"}
      onClick={install}
      menuLabel="More update options"
      menu={
        state === "scheduled" ? (
          <MenuItem onClick={updates.cancelScheduled}>
            Cancel scheduled update
          </MenuItem>
        ) : (
          <MenuItem onClick={updates.installWhenIdle}>
            Update when agents are idle
          </MenuItem>
        )
      }
    >
      {content}
    </SplitButton>
  );
}

function actionLabel(
  state: "ready" | "scheduled" | "installing",
  working: number,
) {
  if (state === "installing") return "Updating Buzz";
  const agents = working === 1 ? "1 agent" : `${working} agents`;
  if (state === "scheduled")
    return working > 0
      ? `Update scheduled for when agents are idle; ${agents} working. Restart Buzz now to install`
      : "Update scheduled for when agents are idle. Restart Buzz now to install";
  return working > 0
    ? `Update ready. Restarting Buzz now interrupts ${agents}`
    : "Update ready. Restart Buzz to install";
}
