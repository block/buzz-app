import { useState } from "react";
import type { AgentControl } from "../../features/agents/control";
import { useAgentControl } from "../../features/agents/control-react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import prompt from "../../../scripts/bestie/prompt.md?raw";

export function BestieSetup({
  control,
  destination,
  owner,
}: {
  control?: AgentControl | undefined;
  destination: string;
  owner: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="compact" variant="ghost" onClick={() => setOpen(true)}>
        Setup Bestie
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Set up a baseline Bestie"
        closeLabel="Close setup"
        description="Create a fresh companion using the existing native agent controls."
      >
        {open && (
          <div className="space-y-4">
            <p className="text-body-sm">
              Use a private channel with you and your Bestie. The baseline needs
              Python 3, the bundled Buzz CLI, and this branch’s scripts/bestie
              directory. Set the agent workspace to the absolute path of this
              checkout.
            </p>
            <p className="text-body-sm">
              After creation, select Bestie from mentions in your private
              channel and send a greeting. Then open Journey and choose its
              identity. All background purposes start paused. The native
              heartbeat wakes hourly while the agent runs, so even an idle check
              can incur model cost.
            </p>
            {control ? (
              <CreateBaseline
                control={control}
                destination={destination}
                owner={owner}
              />
            ) : (
              <p className="text-body-sm">
                Open the development desktop to create an agent. Browser-only
                mode can inspect memories through the development broker.
              </p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
function CreateBaseline({
  control,
  destination,
  owner,
}: {
  control: AgentControl;
  destination: string;
  owner: string;
}) {
  const state = useAgentControl(control);
  const [workspace, setWorkspace] = useState("");
  const [create, setCreate] = useState(false);
  return (
    <div className="space-y-3">
      <Field label="Path to this buzz-app checkout">
        <Input
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
          placeholder="/absolute/path/to/buzz-app"
        />
      </Field>
      <Button
        disabled={
          !workspace.trim().startsWith("/") || !state.data?.createAvailable
        }
        onClick={() => setCreate(true)}
      >
        Configure new Bestie
      </Button>
      {!state.data?.createAvailable && (
        <p role="status" className="text-body-sm">
          Agent creation requires the development desktop and a connected
          community. Use Agents to check runtime availability.
        </p>
      )}
      {create && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={destination}
          owner={owner}
          onClose={() => setCreate(false)}
          preset={{
            name: "Bestie",
            workspace: workspace.trim(),
            systemPrompt: prompt,
            environment: {
              BUZZ_ACP_HEARTBEAT_INTERVAL: "3600",
              BUZZ_ACP_HEARTBEAT_PROMPT:
                "BESTIE_HEARTBEAT: Read the Bestie baseline state using python3 scripts/bestie/state.py read. Follow the system prompt for due purposes only. Stay silent when uninitialized or nothing is due.",
            },
          }}
        />
      )}
    </div>
  );
}
