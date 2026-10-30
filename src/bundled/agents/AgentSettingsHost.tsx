import { ProviderDialog } from "./ProviderDialog";
import { useId, useRef, useState } from "react";
import type {
  Agent,
  AgentSettingsHost,
  Agents,
  Carry,
  RegisteredAgentType,
} from "../../features/agents/service";
import { ArrowRightIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { CaretDownIcon } from "../../shared/design-system/icons";
import {
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One settings composition for both the Agents page and profile panes. */
export function useAgentSettingsHost(options: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
}): {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  settingsHost: AgentSettingsHost;
  discard(): void;
};
export function useAgentSettingsHost(options: {
  agents: Agents | undefined;
  agent: Agent | undefined;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
}): {
  agent: Agent | undefined;
  type: RegisteredAgentType | undefined;
  settingsHost: AgentSettingsHost | undefined;
  discard(): void;
};
export function useAgentSettingsHost({
  agents,
  agent,
  type,
  types,
}: {
  agents: Agents | undefined;
  agent: Agent | undefined;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
}): {
  agent: Agent | undefined;
  type: RegisteredAgentType | undefined;
  settingsHost: AgentSettingsHost | undefined;
  discard(): void;
} {
  const [pendingType, setPendingType] = useState<{
    key: string;
    config: unknown;
  }>();
  const stagedType =
    agent && pendingType?.key !== agent.type ? pendingType : undefined;
  const settingsType =
    types.find((item) => item.key === stagedType?.key) ?? type;
  const settingsAgent =
    agent && stagedType
      ? { ...agent, type: stagedType.key, config: stagedType.config }
      : agent;
  const pendingTypeSave = stagedType
    ? async (config: unknown = stagedType.config) => {
        if (!agents || !agent) return;
        await agents.retype(agent.key, stagedType.key, { config });
        setPendingType(undefined);
      }
    : undefined;
  const showTypeControl =
    agent?.place === "here" && types.some((item) => item.key !== agent.type);
  return {
    agent: settingsAgent,
    type: settingsType,
    discard: () => setPendingType(undefined),
    settingsHost:
      agents && agent
        ? {
            ...(pendingTypeSave ? { pendingSave: pendingTypeSave } : {}),
            ...(showTypeControl
              ? {
                  typeControl: (dirty: boolean) => (
                    <TypeField
                      agents={agents}
                      agent={agent}
                      type={type}
                      types={types}
                      dirty={dirty}
                      selected={stagedType?.key ?? agent.type}
                      onSelect={setPendingType}
                    />
                  ),
                }
              : {}),
          }
        : undefined,
  };
}

const CARRY_LABELS: Record<keyof Carry, string> = {
  instructions: "Instructions",
  workspace: "Workspace",
};
const CARRY_KEYS = Object.keys(CARRY_LABELS) as (keyof Carry)[];

function TypeField({
  agents,
  agent,
  type,
  types,
  dirty,
  selected,
  onSelect,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
  dirty: boolean;
  selected: string;
  onSelect(type: { key: string; config: unknown } | undefined): void;
}) {
  const available = agent.place === "here" ? types : [];
  const others = available.filter((item) => item.key !== agent.type);
  const selectedType = available.find((item) => item.key === selected) ?? type;
  const TypeIcon = selectedType?.icon;
  const [error, setError] = useState("");
  const providerButton = useRef<HTMLButtonElement>(null);
  const [checking, setChecking] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [migration, setMigration] = useState<{
    target: RegisteredAgentType;
    preview: ReturnType<Agents["previewRetype"]>;
  }>();
  const choose = (next: string) => {
    if (next === selected) return;
    if (next === agent.type) {
      onSelect(undefined);
      return;
    }
    const target = available.find((item) => item.key === next);
    if (!target || target.remote) return;
    setError("");
    try {
      setMigration({
        target,
        preview: agents.previewRetype(agent.key, target.key),
      });
    } catch (reason) {
      setError(message(reason));
    }
  };
  const stage = () => {
    if (!migration) return;
    setError("");
    onSelect({ key: migration.target.key, config: migration.preview.config });
    setMigration(undefined);
  };
  const prepare = async () => {
    if (!migration || checking) return;
    const provider = migration.target.provider;
    if (!provider) return stage();
    setChecking(true);
    setError("");
    try {
      await provider.check();
      if (provider.snapshot().readiness === "ready") stage();
      else setConfiguring(true);
    } catch {
      // The provider owns install/auth recovery, including failed checks.
      setConfiguring(true);
    } finally {
      setChecking(false);
    }
  };
  const value = (
    <span className="flex min-w-0 items-center gap-2">
      {TypeIcon && <TypeIcon size={20} aria-hidden="true" />}
      {selectedType?.title ?? "Type unavailable"}
    </span>
  );
  return (
    <>
      <PreferenceRow
        title="Harness"
        trailing={
          others.length > 0 ? (
            <div className="buzz-select" data-variant="compact">
              <MenuRoot onOpenChange={(open) => open && setError("")}>
                <MenuTrigger
                  aria-label={`Change harness from ${selectedType?.title ?? "unavailable harness"}`}
                  render={
                    <Button
                      ref={providerButton}
                      variant="outline"
                      shape="control"
                      size="sm"
                    >
                      {value}
                      <CaretDownIcon size={14} aria-hidden="true" />
                    </Button>
                  }
                />
                <MenuPopup>
                  <MenuRadioGroup
                    value={selected}
                    onValueChange={(next) => choose(String(next))}
                  >
                    {available.map((item) => {
                      if (item.remote)
                        return (
                          <HostedHarnessChoice key={item.key} type={item} />
                        );
                      const Icon = item.icon;
                      return (
                        <MenuRadioItem
                          key={item.key}
                          value={item.key}
                          selection="highlight"
                          closeOnClick
                        >
                          <ChoiceRow
                            label={item.title}
                            leading={Icon ? <Icon size={20} /> : undefined}
                          />
                        </MenuRadioItem>
                      );
                    })}
                  </MenuRadioGroup>
                </MenuPopup>
              </MenuRoot>
            </div>
          ) : (
            value
          )
        }
      />
      {error && !migration && (
        <p role="alert" className="m-0 mt-1 text-body-sm text-danger">
          {error}
        </p>
      )}
      <Dialog
        open={Boolean(migration) && !configuring}
        preventClose={checking}
        onOpenChange={(open) => {
          if (!open) {
            setMigration(undefined);
            setError("");
          }
        }}
        title={
          migration
            ? `Move ${agent.name} to ${migration.target.title}?`
            : "Move agent?"
        }
        headerGap="compact"
        actions={
          <>
            <Button disabled={checking} onClick={() => setMigration(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={checking}
              onClick={() => void prepare()}
            >
              Continue
            </Button>
          </>
        }
      >
        {migration && (
          <MigrationPreview
            source={type}
            target={migration.target}
            preview={migration.preview}
            discardDraft={dirty}
          />
        )}
      </Dialog>
      {configuring && migration && (
        <ProviderDialog
          type={migration.target}
          finalFocus={providerButton}
          onClose={() => {
            setConfiguring(false);
            if (migration.target.provider?.snapshot().readiness === "ready")
              stage();
            else setMigration(undefined);
          }}
        />
      )}
    </>
  );
}

function HostedHarnessChoice({ type }: { type: RegisteredAgentType }) {
  const triggerId = useId();
  const trigger = useRef<HTMLElement>(null);
  const description = useId();
  const [open, setOpen] = useState(false);
  const Icon = type.icon;
  return (
    <PopoverRoot
      open={open}
      triggerId={triggerId}
      onOpenChange={(next, details) => {
        // The menu returns focus to itself when the pointer enters this card.
        // Let hover dismissal handle that move; another item still closes it.
        if (
          details.reason === "focus-out" &&
          "relatedTarget" in details.event &&
          details.event.relatedTarget ===
            trigger.current?.closest('[role="menu"]')
        ) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        id={triggerId}
        openOnHover="preview"
        nativeButton={false}
        role="menuitemradio"
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-describedby={open ? description : undefined}
        render={
          <MenuRadioItem
            ref={trigger}
            value={type.key}
            selection="highlight"
            disabled
          >
            <ChoiceRow
              label={type.title}
              leading={Icon ? <Icon size={20} /> : undefined}
            />
          </MenuRadioItem>
        }
      />
      <PopoverPopup
        side="right"
        align="start"
        aria-label={`${type.title} hosting`}
        initialFocus={false}
        finalFocus={false}
      >
        <PopoverDescription id={description}>
          This agent’s signing key is stored on this device. Buzz can’t move
          that identity to {type.title} yet. To run hosted, create a new{" "}
          {type.title} agent.
        </PopoverDescription>
      </PopoverPopup>
    </PopoverRoot>
  );
}

export function MigrationPreview({
  source,
  target,
  preview,
  discardDraft,
}: {
  source: RegisteredAgentType | undefined;
  target: RegisteredAgentType;
  preview: ReturnType<Agents["previewRetype"]>;
  discardDraft: boolean;
}) {
  const SourceIcon = source?.icon;
  const TargetIcon = target.icon;
  const carry = CARRY_KEYS.filter(
    (key) => preview.moved.includes(key) || preview.dropped.includes(key),
  );
  const warning = source?.migrationWarning;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3 text-body">
        <span className="flex items-center gap-2">
          {SourceIcon && <SourceIcon size={24} aria-hidden="true" />}
          {source?.title ?? "Unavailable type"}
        </span>
        <ArrowRightIcon size={16} aria-hidden="true" />
        <span className="flex items-center gap-2">
          {TargetIcon && <TargetIcon size={24} aria-hidden="true" />}
          {target.title}
        </span>
      </div>
      <p className="m-0 text-body-sm text-secondary">
        The provider changes when you save settings. Your agent will continue
        the conversation in Buzz.
        {warning && ` ${warning}`}
      </p>
      {discardDraft && (
        <p className="m-0 text-body-sm text-warning">
          Unsaved Settings changes will be discarded when you continue.
        </p>
      )}
      {(carry.length > 0 || preview.settings.length > 0) && (
        <dl className="m-0 grid gap-2">
          {carry.map((key) => {
            const moved = preview.moved.includes(key);
            const dropped = preview.dropped.includes(key);
            return (
              <div className="flex justify-between gap-3" key={key}>
                <dt>{CARRY_LABELS[key]}</dt>
                <dd
                  className={`m-0 text-body-sm ${dropped ? "text-danger" : "text-secondary"}`}
                >
                  {dropped ? "Dropped" : moved ? "Moves" : null}
                </dd>
              </div>
            );
          })}
          {preview.settings.map((setting) => (
            <div className="flex justify-between gap-3" key={setting.id}>
              <dt>{setting.label}</dt>
              <dd
                className={`m-0 text-body-sm ${setting.outcome === "reset" ? "text-warning" : "text-danger"}`}
              >
                {setting.outcome === "reset" ? "Resets" : "Dropped"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
