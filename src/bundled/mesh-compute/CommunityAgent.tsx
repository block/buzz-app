import { useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import { Button } from "../../shared/design-system/ui/Button";

/** Reuse the normal owner-reviewed create/start/profile flow; never create on mount. */
export function CommunityAgent({
  control,
  destination,
  owner,
}: {
  control: AgentControl;
  destination: string;
  owner: string;
}) {
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Use community compute">
      <h2 className="text-label">Use community compute</h2>
      <p className="text-body-sm text-secondary">
        Create an agent that automatically uses models shared by this community.
        You don’t need to share your own machine.
      </p>
      <Button
        onClick={() => {
          setOpen(true);
          void control.refresh();
        }}
      >
        Create community agent
      </Button>
      {open && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={destination}
          owner={owner}
          sharedCompute
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
