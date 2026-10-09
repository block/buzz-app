import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import type { InstructionEditingActions } from "./AgentInstructions";
import {
  randomAgentAvatar,
  isRetiredAgentAvatar,
} from "../../features/agents/avatar-packs";
import { AgentCreateHeader } from "./AgentCreateHeader";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  agentFailureReason,
  type AgentControl,
  type AgentControlState,
  type CloneSettings,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSettingsFields } from "./AgentSettingsFields";
import {
  agentDraft,
  agentEdit,
  harnessKind,
  type AgentDraft,
} from "./agent-edit";

/** The Agent defaults harness is copied at creation; the rest is inherited at start. */
function newAgentDraft(state: AgentControlState): AgentDraft {
  const defaults = state.data?.defaultSettings;
  const chosen = state.data?.harnessOptions?.find(
    (option) =>
      option.available !== false &&
      harnessKind(option.command) === (defaults?.harness ?? "buzz-agent"),
  );
  const command = chosen?.command ?? "buzz-agent";
  const inherits = defaults?.harness === "buzz-agent" && !!defaults.provider;
  return {
    revision: 0,
    name: "",
    systemPrompt: "",
    ...(state.data?.avatarEditingAvailable
      ? { picture: randomAgentAvatar().url }
      : {}),
    sessionPolicy: null,
    workspace: state.data?.defaultWorkspace ?? "",
    command,
    args: JSON.stringify(chosen?.defaultArgs ?? []),
    model: "",
    provider:
      command !== "buzz-agent" ||
      inherits ||
      state.data?.agentDefaults?.provider
        ? ""
        : (chosen?.providers[0]?.value ?? "databricks_v2"),
    environment: {},
  };
}

type CreatePhase = "creating" | "starting" | "publishing" | "checking";

export function AgentCreateDialog({
  control,
  state,
  destination,
  owner,
  source,
  initialSettings,
  onClose,
  onOpenHarnesses,
}: {
  control: AgentControl;
  onOpenHarnesses?: (() => void) | undefined;
  state: AgentControlState;
  destination: string;
  owner: string;
  source?: AgentView;
  initialSettings?: CloneSettings | undefined;
  onClose(): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<AgentDraft>(() => {
    const initial = source
      ? {
          ...agentDraft(source),
          name: `${source.name} copy`,
        }
      : {
          ...newAgentDraft(state),
          name: initialSettings?.name ?? "",
          systemPrompt: initialSettings?.systemPrompt ?? "",
        };
    return { ...initial, environment: { BUZZ_ACP_AGENTS: "10" } };
  });
  useEffect(() => {
    if (source || !state.data?.avatarEditingAvailable) return;
    setDraft((current) =>
      !current.picture || isRetiredAgentAvatar(current.picture)
        ? { ...current, picture: randomAgentAvatar().url }
        : current,
    );
  }, [source, state.data?.avatarEditingAvailable]);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<AgentView | null>(null);
  const [nextStep, setNextStep] = useState<"start" | "profile">("start");
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<CreatePhase | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = !!(
    destination &&
    owner &&
    state.data?.createAvailable &&
    control.create
  );
  const runtimeBlocked =
    !state.data?.runtimeAvailable && (!saved || nextStep === "start");
  const [modelTarget, setModelTarget] = useState<HTMLDivElement | null>(null);
  const [avatarActionTarget, setAvatarActionTarget] =
    useState<HTMLDivElement | null>(null);
  const avatarNavigation = useRef<{ back(): void }>(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [avatarActive, setAvatarActive] = useState(false);
  const instructionEditing = useRef<InstructionEditingActions>(null);
  const [instructionActive, setInstructionActive] = useState(false);
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const busy = phase !== null;
  const blocked = busy || state.busy || state.status !== "ready";
  const create = async () => {
    if (
      instructionBusy ||
      avatarBusy ||
      blocked ||
      runtimeBlocked ||
      (!saved && (!available || !control.create))
    )
      return;
    setError(undefined);
    let step: "creating" | "starting" | "publishing" = "creating";
    let agent = saved;
    let startFailure: string | null = null;
    try {
      if (!agent) {
        let edit: ReturnType<typeof agentEdit>;
        try {
          edit = agentEdit(draft);
        } catch (problem) {
          if (mounted.current)
            setError(
              problem instanceof Error
                ? problem.message
                : "Check the agent settings and try again.",
            );
          return;
        }
        setPhase("creating");
        if (!control.create) return;
        agent = await control.create(requestId, destination, owner, edit);
      }
      const created = agent;
      if (!saved && mounted.current) {
        setDraft((current) => ({ ...current, environment: {} }));
        setSaved(agent);
      }

      if (!saved || nextStep === "start") {
        const current = control
          .snapshot()
          .data?.agents.find((item) => item.id === created.id);
        if (current?.status !== "running") {
          step = "starting";
          if (mounted.current) setPhase(step);
          const result = await control.action(created.id, "start");
          const started = result.agents.find((item) => item.id === created.id);
          if (started?.status !== "running") {
            startFailure = `${created.name} was created, but couldn't start. ${started?.error ?? "Check its settings, then try Start again."}`;
          }
        }
        if (!startFailure && mounted.current) setNextStep("profile");
      }

      const current = control
        .snapshot()
        .data?.agents.find((item) => item.id === created.id);
      if (current?.profilePending !== false) {
        step = "publishing";
        if (mounted.current) setPhase(step);
        if (!control.publishProfile)
          throw new Error(
            "Profile setup is unavailable. Rebuild the desktop app.",
          );
        await control.publishProfile(created.id);
      }
      if (mounted.current) {
        if (startFailure) setError(startFailure);
        else onClose();
      }
    } catch (problem) {
      if (mounted.current) setPhase("checking");
      await control.refresh();
      if (!mounted.current) return;
      const detail = agentFailureReason(problem);
      const reason = detail && ` ${detail}`;
      const refreshed = control.snapshot();
      const created = agent;
      const current = created
        ? refreshed.data?.agents.find((item) => item.id === created.id)
        : undefined;
      if (step === "starting" && current?.status === "running") {
        setNextStep("profile");
        setError(undefined);
      } else if (step === "publishing" && current?.profilePending === false) {
        if (startFailure) setError(startFailure);
        else onClose();
      } else if (step === "creating") {
        setError(
          `We couldn't confirm whether the agent was created.${reason} Check the agent list before trying again.`,
        );
      } else if (refreshed.status === "ready" && current) {
        setError(
          step === "starting"
            ? `${agent?.name ?? draft.name} was saved, but couldn't start.${reason} Check its card, then select Start agent to try again.`
            : startFailure
              ? `${startFailure} Profile setup also didn't finish.${reason}`
              : `${agent?.name ?? draft.name} was saved and started, but profile setup didn't finish.${reason} Select Finish profile to try again.`,
        );
      } else {
        setError(
          step === "starting"
            ? `${agent?.name ?? draft.name} was saved, but we couldn't confirm whether it started. Refresh status before trying again.`
            : `${agent?.name ?? draft.name} was saved, but we couldn't confirm its profile setup. Refresh status before trying again.`,
        );
      }
    } finally {
      if (mounted.current) setPhase(null);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !dirty && !blocked) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <Dialog.Popup
          initialFocus={() =>
            form.current?.querySelector<HTMLInputElement>(
              'input[placeholder="Agent name"], input:not([role="combobox"])',
            ) ?? false
          }
          aria-modal="true"
          data-buzz-ui=""
          className="buzz-dialog agent-dialog text-body"
        >
          <header className="buzz-dialog-header">
            <Dialog.Title className="text-heading">
              {configurationOpen
                ? "AI configuration"
                : source
                  ? `Duplicate ${source.name}`
                  : initialSettings
                    ? "Clone agent"
                    : "Create agent"}
            </Dialog.Title>
            <Dialog.Close
              render={
                <IconButton
                  aria-label="Close"
                  size="compact"
                  icon={<XIcon size={16} aria-hidden="true" />}
                />
              }
            />
          </header>
          {initialSettings && (
            <p className="text-body-sm text-secondary">
              Only the name and instructions were copied. Review them for
              embedded secrets. Choose this computer’s workspace and runtime
              settings. Identity keys, environment values, history and community
              membership are not copied. The source stays unchanged.
            </p>
          )}
          <form
            ref={form}
            className="buzz-dialog-body flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !instructionActive &&
                !configurationOpen &&
                !avatarActive &&
                !configurationOpen
              )
                void create();
            }}
          >
            {state.data?.avatarEditingAvailable && (
              <div hidden={configurationOpen}>
                <AgentCreateHeader
                  avatarNavigationRef={avatarNavigation}
                  avatarActionTarget={avatarActionTarget}
                  onAvatarActiveChange={setAvatarActive}
                  instructionEditingRef={instructionEditing}
                  onInstructionActiveChange={setInstructionActive}
                  instructions={draft.systemPrompt}
                  onInstructionBusyChange={setInstructionBusy}
                  modelSlotRef={setModelTarget}
                  community={destination}
                  onBusyChange={setAvatarBusy}
                  name={draft.name}
                  picture={draft.picture}
                  disabled={blocked || !!saved}
                  onChange={(patch) => {
                    setDraft((current) => ({ ...current, ...patch }));
                    setDirty(true);
                  }}
                />
              </div>
            )}
            <AgentSettingsFields
              configurationOpen={configurationOpen}
              onConfigurationOpenChange={setConfigurationOpen}
              onInstructionBusyChange={setInstructionBusy}
              cardLayout
              modelTarget={modelTarget}
              hideInstructions={!!state.data?.avatarEditingAvailable}
              hideName={!!state.data?.avatarEditingAvailable}
              draft={draft}
              control={control}
              state={state}
              disabled={blocked || !!saved}
              onOpenHarnesses={onOpenHarnesses}
              discardEdits={dirty}
              onChange={(patch) => {
                setDraft({ ...draft, ...patch });
                setDirty(true);
                setError(undefined);
              }}
            />
            {source?.harness.environmentKeys.length ? (
              <p role="status" className="text-body-sm text-secondary">
                Re-enter environment values for{" "}
                {source.harness.environmentKeys.join(", ")}. Saved values cannot
                be copied into a new identity.
              </p>
            ) : null}
            {!available && (
              <p role="status">
                Connect to a community and use a rebuilt desktop app to create
                an agent.
              </p>
            )}
            {runtimeBlocked && (
              <p role="alert">
                This app’s agent runtime is unavailable. Repair or rebuild the
                desktop app before {saved ? "starting" : "creating"} an agent.
                {state.data?.runtimeMessage && ` ${state.data.runtimeMessage}`}
              </p>
            )}
            {busy && (
              <p role="status">
                {phase === "creating" && "Creating agent…"}
                {phase === "starting" &&
                  `${saved?.name ?? draft.name} was created. Starting it…`}
                {phase === "publishing" &&
                  `${saved?.name ?? draft.name} was saved. Finishing its profile…`}
                {phase === "checking" && "Checking agent status…"}
              </p>
            )}
            {saved && !busy && !error && (
              <p role="status">
                {nextStep === "start"
                  ? `${saved.name} was saved. Start it to finish setup.`
                  : `${saved.name} was saved and started. Finish its profile setup.`}
              </p>
            )}
            {error && error !== "Enter an agent name." && (
              <p role="alert">{error}</p>
            )}
            {state.status === "error" && !busy && (
              <Button onClick={() => void control.refresh()}>
                Retry status
              </Button>
            )}
            <div className="buzz-dialog-actions">
              {(instructionActive || avatarActive || configurationOpen) && (
                <Button
                  style={{ marginRight: "auto" }}
                  onClick={() =>
                    configurationOpen
                      ? setConfigurationOpen(false)
                      : instructionActive
                        ? instructionEditing.current?.back()
                        : avatarNavigation.current?.back()
                  }
                >
                  Back
                </Button>
              )}
              <div ref={setAvatarActionTarget} hidden={!avatarActive} />
              {!avatarActive && (
                <Button
                  type={
                    instructionActive || configurationOpen ? "button" : "submit"
                  }
                  onClick={
                    configurationOpen
                      ? () => setConfigurationOpen(false)
                      : instructionActive
                        ? () => instructionEditing.current?.done()
                        : undefined
                  }
                  variant="primary"
                  disabled={
                    instructionBusy ||
                    (!instructionActive &&
                      !configurationOpen &&
                      (avatarBusy ||
                        blocked ||
                        runtimeBlocked ||
                        (!saved && (!available || !draft.name.trim()))))
                  }
                >
                  {configurationOpen
                    ? "Done"
                    : instructionActive
                      ? "Done editing"
                      : busy
                        ? phase === "starting"
                          ? "Starting…"
                          : phase === "publishing"
                            ? "Finishing…"
                            : phase === "checking"
                              ? "Checking…"
                              : "Creating…"
                        : saved
                          ? nextStep === "start"
                            ? "Start agent"
                            : "Finish profile"
                          : initialSettings
                            ? "Clone agent"
                            : "Create agent"}
                </Button>
              )}
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
