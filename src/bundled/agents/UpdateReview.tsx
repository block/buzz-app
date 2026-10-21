import { useId, useState, useSyncExternalStore } from "react";
import type {
  AgentUpdateRequest,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { MigrationPreview } from "./AgentSettingsHost";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The owner reviews another agent's proposed changes before any is saved. */
export function UpdateReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(
    agents.subscribe,
    agents.updateRequests,
  );
  const types = useSyncExternalStore(agents.subscribe, agents.types);
  const request = requests[0];
  if (!request) return null;
  return (
    <UpdateDialog
      key={request.id}
      agents={agents}
      types={types.filter((type) => !type.remote)}
      request={request}
    />
  );
}

function UpdateDialog({
  agents,
  types,
  request,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  request: AgentUpdateRequest;
}) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(request.name);
  const [type, setType] = useState(request.type);
  const [instructions, setInstructions] = useState(request.instructions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const source = types.find((item) => item.key === request.agentType);
  let preview: ReturnType<Agents["previewRetype"]> | undefined;
  try {
    preview =
      type && type !== request.agentType
        ? agents.previewRetype(request.agent, type)
        : undefined;
  } catch {
    preview = undefined;
  }
  const target = types.find((item) => item.key === type);
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await agents.approveUpdate(request.id, {
        ...(name !== undefined && { name }),
        ...(type !== undefined && { type }),
        ...(instructions !== undefined && { instructions }),
      });
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) agents.dismissUpdate(request.id);
      }}
      title={`Change ${request.agentName}`}
      description={`${request.requesterName} proposed these changes in ${request.community}. Nothing changes until you save.`}
      size="wide"
      chromeSpacing="padded"
      dismissOnOutsideClick={false}
      preventClose={pending}
      actions={
        <>
          <Button disabled={pending} onClick={() => setOpen(false)}>
            Discard
          </Button>
          <Button variant="primary" type="submit" form={form} loading={pending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="grid gap-4"
        aria-label={`Changes to ${request.agentName}`}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {name !== undefined && (
          <Field label="Name" description={`Now ${request.agentName}`}>
            <Input
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        {type !== undefined && (
          <SettingsGroup>
            <PreferenceRow
              title="Harness"
              subtitle={`Now ${source?.title ?? request.agentType}`}
              trailing={
                <Select
                  label="Harness"
                  variant="compact"
                  align="end"
                  value={type}
                  disabled={pending}
                  groups={[
                    {
                      label: "",
                      options: types.map((item) => ({
                        value: item.key,
                        label: item.title,
                      })),
                    },
                  ]}
                  onValueChange={setType}
                />
              }
            />
          </SettingsGroup>
        )}
        {preview && target && (
          <MigrationPreview
            source={source}
            target={target}
            preview={preview}
            discardDraft={false}
          />
        )}
        {instructions !== undefined && (
          <Field label="Instructions">
            <Textarea
              rows={8}
              value={instructions}
              disabled={pending}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
