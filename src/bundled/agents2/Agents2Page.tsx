import { useState } from "react";
import styles from "./Agents2Page.module.css";
import { AgentTabs } from "./AgentTabs";
import { useAgents2 } from "../../features/agents2/react";
import type {
  Agent,
  Agents2,
  RegisteredAgentType,
} from "../../features/agents2/service";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { Input } from "../../shared/design-system/ui/Input";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function Agents2Page({ agents2 }: { agents2: Agents2 }) {
  const { snapshot, types } = useAgents2(agents2);
  const [open, setOpen] = useState<string>();
  const [creating, setCreating] = useState(false);
  const opened = snapshot.agents.find((agent) => agent.pubkey === open);
  const typeOf = (agent: Agent) =>
    types.find((type) => type.key === agent.type);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents2">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={opened ? opened.name : "Agents2"}
            actions={
              opened ? (
                <Button size="compact" onClick={() => setOpen(undefined)}>
                  All agents
                </Button>
              ) : undefined
            }
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {snapshot.status === "unavailable" ? (
              <EmptyState
                icon="✦"
                title="Agents2 runs in the desktop app"
                description="Agent keys stay in the desktop app's native custody."
              />
            ) : snapshot.status === "error" ? (
              <EmptyState
                icon="!"
                title="Agents could not load"
                description={snapshot.error ?? "Try again."}
              />
            ) : opened ? (
              <AgentDetail
                key={opened.pubkey}
                agents2={agents2}
                agent={opened}
                type={typeOf(opened)}
                onRemoved={() => setOpen(undefined)}
              />
            ) : (
              <div className={styles.grid}>
                <NewAgentCard
                  disabled={!types.length}
                  onClick={() => setCreating(true)}
                />
                {snapshot.agents.map((agent) => (
                  <AgentCard
                    key={agent.pubkey}
                    agents2={agents2}
                    agent={agent}
                    type={typeOf(agent)}
                    onOpen={() => setOpen(agent.pubkey)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </FullPageSurface>
      <CreateAgentDialog
        open={creating}
        agents2={agents2}
        types={types}
        onClose={() => setCreating(false)}
        onCreated={(agent) => {
          setCreating(false);
          setOpen(agent.pubkey);
        }}
      />
    </div>
  );
}

function NewAgentCard({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <div className={`${styles.card} ${styles.newCard}`}>
      <div className={styles.collage} aria-hidden="true">
        {["✦", "◆", "●", "▲", "✿", "◼"].map((shape, index) => (
          <span key={shape} data-index={index}>
            {shape}
          </span>
        ))}
      </div>
      <Button
        variant="primary"
        size="compact"
        disabled={disabled}
        onClick={onClick}
      >
        New agent
      </Button>
      {disabled && (
        <p className="text-body-sm text-secondary">
          Enable an agent type plugin
        </p>
      )}
    </div>
  );
}

function AgentCard({
  agents2,
  agent,
  type,
  onOpen,
}: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  onOpen(): void;
}) {
  const Back = type?.Back;
  return (
    <div className={styles.card}>
      <div className={styles.flip}>
        <div className={styles.front}>
          <div className={styles.portrait}>
            <Avatar alt="" fallback={agent.name} size="fill" shape="squircle" />
          </div>
          <h3 className="text-heading">{agent.name}</h3>
          <p className="text-body-sm text-secondary">
            {type?.title ?? "Type unavailable"}
          </p>
        </div>
        <div className={styles.back} aria-hidden="true">
          {Back ? (
            <Back
              agent={agent}
              save={(change) => agents2.save(agent.pubkey, change)}
            />
          ) : (
            <p className="text-body-sm text-secondary">
              {type?.description ??
                type?.title ??
                "Enable this agent's plugin."}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        className={styles.open}
        aria-label={`Open ${agent.name}`}
        onClick={onOpen}
      />
    </div>
  );
}

// The build/expand frame: identity on the left, the type's tabs on the right.
function AgentDetail({
  agents2,
  agent,
  type,
  onRemoved,
}: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  onRemoved(): void;
}) {
  const [name, setName] = useState(agent.name);
  const [pending, setPending] = useState<"save" | "remove">();
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const act = async (kind: "save" | "remove", action: () => Promise<void>) => {
    setPending(kind);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <div className={styles.detail}>
      <aside className={styles.identity}>
        <div className={styles.portraitLarge}>
          <Avatar alt="" fallback={agent.name} size="fill" shape="squircle" />
        </div>
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {name.trim() !== agent.name && (
          <Button
            size="compact"
            loading={pending === "save"}
            onClick={() =>
              void act("save", () => agents2.save(agent.pubkey, { name }))
            }
          >
            Save name
          </Button>
        )}
        <p className="text-body-sm text-secondary">
          {type?.title ?? "Type unavailable"}
        </p>
        <Button
          size="compact"
          variant="destructive"
          disabled={!!pending}
          onClick={() => setConfirming(true)}
        >
          Delete agent
        </Button>
        {error && (
          <p role="alert" className="text-body-sm">
            {error}
          </p>
        )}
      </aside>
      <section className={styles.tabs} aria-label={`${agent.name} settings`}>
        {type ? (
          <AgentTabs agents2={agents2} agent={agent} type={type} />
        ) : (
          <p className="text-body-sm text-secondary">
            Enable the plugin that provides this agent's type to change it.
          </p>
        )}
      </section>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description="This removes its key from this device. It can't be undone."
        preventClose={pending === "remove"}
        actions={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={pending === "remove"}
              onClick={() =>
                void act("remove", async () => {
                  await agents2.remove(agent.pubkey);
                  setConfirming(false);
                  onRemoved();
                })
              }
            >
              Delete
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}

function CreateAgentDialog({
  open,
  agents2,
  types,
  onClose,
  onCreated,
}: {
  open: boolean;
  agents2: Agents2;
  types: readonly RegisteredAgentType[];
  onClose(): void;
  onCreated(agent: Agent): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const create = async () => {
    if (!chosen) return;
    setPending(true);
    setError("");
    try {
      const agent = await agents2.create({ type: chosen.key, name });
      setName("");
      onCreated(agent);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="New agent"
      description="It gets its own key on this device, and runs while the app is open."
      preventClose={pending}
      actions={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!name.trim() || !chosen}
            onClick={() => void create()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Select
          label="Type"
          value={chosen?.key ?? ""}
          onValueChange={(value) => setType(value)}
          groups={[
            {
              label: "Agent types",
              options: types.map((item) => ({
                value: item.key,
                label: item.title,
              })),
            },
          ]}
          {...(chosen?.description ? { description: chosen.description } : {})}
        />
        {error && (
          <p role="alert" className="text-body-sm">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
