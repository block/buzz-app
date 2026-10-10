import { AgentInstructions } from "./AgentInstructions";
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import {
  gooseApiKey,
  effectiveGooseProvider,
  harnessKind,
  isGoose,
  PI_API_KEYS,
  type AgentDraft,
} from "./agent-edit";
import { AgentEnvironmentEditor } from "./AgentEnvironmentEditor";
import { AgentHarnessEditor } from "./AgentHarnessEditor";
import { AgentModelPicker } from "./AgentModelPicker";
import { ProviderApiKeyField } from "./ProviderApiKeyField";
import { harnessPreset } from "../../features/agents/harness-presets";
import { PresetSetupHint } from "../../features/agents/PresetSetupHint";
import { Button } from "../../shared/design-system/ui/Button";
import { CodexConfigurationFields } from "./CodexConfigurationFields";
import { harnessOption, harnessPolicy } from "./harness-policy";

// Draft → Agent defaults → build floor, as native resolves it; null when a
// saved or global BUZZ_AGENT_PROVIDER override hides the effective value.
function effectiveBuzzProvider(
  draft: AgentDraft,
  savedKeys: string[],
  data: AgentControlState["data"],
) {
  const key = "BUZZ_AGENT_PROVIDER";
  const override = draft.environment[key];
  if (typeof override === "string") return override;
  if (
    data?.defaultSettings?.environmentKeys.includes(key) ||
    (override === undefined && savedKeys.includes(key))
  )
    return null;
  const inherited = data?.defaultSettings?.harness === "buzz-agent";
  return (
    draft.provider ||
    (inherited ? data?.defaultSettings?.provider : "") ||
    data?.agentDefaults?.provider
  );
}

function providerApiKey(
  draft: AgentDraft,
  savedKeys: string[],
  data: AgentControlState["data"],
) {
  if (
    harnessPolicy(data?.harnessOptions, draft.command, draft.integration)
      ?.authentication === "external"
  )
    return undefined;
  if (draft.command.split("/").at(-1) === "buzz-pi-acp")
    return PI_API_KEYS[draft.provider];
  if (harnessKind(draft.command) === "buzz-agent")
    return ["openai", "openai-compat"].includes(
      effectiveBuzzProvider(draft, savedKeys, data) ?? "",
    )
      ? { label: "OpenAI", env: "OPENAI_COMPAT_API_KEY" }
      : undefined;
  if (!isGoose(draft.command)) return undefined;
  const provider = effectiveGooseProvider(
    draft.provider,
    draft.environment,
    savedKeys,
  );
  return provider ? gooseApiKey(provider) : undefined;
}

/** Create and Edit share the same settings and native model discovery. */
export function AgentSettingsFields({
  id,
  savedRevision,
  draft,
  control,
  state,
  disabled,
  environmentKeys = [],
  onChange,
  onOpenHarnesses,
  discardEdits = false,
  cardLayout = false,
  quickModelOnly = false,
  configurationOpen,
  onConfigurationOpenChange,
  hideName = false,
  hideInstructions = false,
  modelTarget,
  onInstructionBusyChange,
}: {
  modelTarget?: HTMLElement | null;
  onInstructionBusyChange?: ((busy: boolean) => void) | undefined;
  cardLayout?: boolean;
  quickModelOnly?: boolean;
  configurationOpen?: boolean;
  onConfigurationOpenChange?: (open: boolean) => void;
  hideName?: boolean;
  hideInstructions?: boolean;
  id?: string | undefined;
  onOpenHarnesses?: (() => void) | undefined;
  discardEdits?: boolean;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  state: AgentControlState;
  disabled: boolean;
  environmentKeys?: string[];
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const [localCustomize, setLocalCustomize] = useState(false);
  const customize = configurationOpen ?? localCustomize;
  const setCustomize = onConfigurationOpenChange ?? setLocalCustomize;
  const showOptions = !cardLayout || customize;
  const [piProviders, setPiProviders] = useState<string[] | null>([]);
  const [providerSelection, setProviderSelection] = useState(0);
  const pi = draft.command.split("/").at(-1) === "buzz-pi-acp";
  const goose = isGoose(draft.command);
  const preset = harnessPreset(draft.command);
  const policy = harnessPolicy(
    state.data?.harnessOptions,
    draft.command,
    draft.integration,
  );
  const option = harnessOption(
    state.data?.harnessOptions,
    draft.command,
    draft.integration,
  );
  const integration =
    draft.integration ?? (option?.id === "codex" ? undefined : option?.id);
  const codex = draft.integration === "codex";
  const globalKeys = state.data?.defaultSettings?.environmentKeys ?? [];
  // Saved and global environment values are write-only; removing an agent's
  // key exposes the global key rather than the visible scalar default.
  const ownOverride = (key: string) =>
    typeof draft.environment[key] === "string" ||
    (draft.environment[key] === undefined && environmentKeys.includes(key));
  const overridden = (key: string) =>
    ownOverride(key) || globalKeys.includes(key);
  // Blank fields inherit Agent defaults for the same harness, then the build
  // floor (Buzz Agent only). Hidden environment overrides are not guessed.
  const inherited =
    state.data?.defaultSettings?.harness === harnessKind(draft.command)
      ? state.data?.defaultSettings
      : undefined;
  const buzzProvider = effectiveBuzzProvider(
    draft,
    environmentKeys,
    state.data,
  );
  const modelDefaultKnown =
    (typeof draft.environment.BUZZ_AGENT_PROVIDER === "string" ||
      !overridden("BUZZ_AGENT_PROVIDER")) &&
    ["BUZZ_AGENT_MODEL", "DATABRICKS_MODEL"].every((key) => !overridden(key));
  const databricks = ["databricks_v2", "databricks-v2", "databricks"].includes(
    buzzProvider ?? "",
  );
  const gooseProvider = goose
    ? effectiveGooseProvider(draft.provider, draft.environment, environmentKeys)
    : null;
  const buzzAgent = harnessKind(draft.command) === "buzz-agent";
  const windows = /Win/i.test(globalThis.navigator?.platform ?? "");
  // An environment selector can override the visible scalar default.
  const [modelKey, providerKey] = policy
    ? [policy.selectorEnvironment?.model, policy.selectorEnvironment?.provider]
    : buzzAgent
      ? ["BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER"]
      : goose
        ? ["GOOSE_MODEL", "GOOSE_PROVIDER"]
        : [undefined, undefined];
  const providerHidden = !!providerKey && overridden(providerKey);
  const modelHidden =
    (!!modelKey && overridden(modelKey)) || (buzzAgent && !modelDefaultKnown);
  const defaultProvider = providerHidden
    ? undefined
    : inherited?.provider ||
      (buzzAgent ? state.data?.agentDefaults?.provider : undefined);
  const defaultModel = modelHidden
    ? undefined
    : inherited?.model ||
      (buzzAgent && databricks ? state.data?.agentDefaults?.model : undefined);
  // An explicit Databricks workspace/filter wins over the global env pair.
  const inheritedKey = (key: string) =>
    buzzAgent &&
    !draft.databricks &&
    globalKeys.includes(key) &&
    !ownOverride(key);
  const inheritedWorkspace = {
    host: inheritedKey("DATABRICKS_HOST"),
    filter: inheritedKey("DATABRICKS_MODEL_FILTER"),
  };
  const apiKey = providerApiKey(draft, environmentKeys, state.data);
  const savedKey = !!apiKey && environmentKeys.includes(apiKey.env);
  const fields = useRef<HTMLDivElement>(null);
  const harnessFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const previous = harnessFocus.current;
    harnessFocus.current = null;
    // Switching harness families replaces the configuration subtree. Keep
    // keyboard focus on its new trigger rather than the discarded node.
    if (previous && !previous.isConnected) {
      fields.current
        ?.querySelector<HTMLElement>('[data-agent-harness] [role="combobox"]')
        ?.focus();
    }
  });
  const change = (patch: Partial<AgentDraft>) => {
    if (
      patch.command !== undefined &&
      document.activeElement instanceof HTMLElement
    ) {
      const active = document.activeElement;
      if (
        active.closest("[data-agent-harness]") ||
        active.getAttribute("role") === "option"
      ) {
        harnessFocus.current = active;
      }
    }
    const key = apiKey?.env;
    // A typed key belongs to the provider it was entered for.
    if (
      key &&
      providerApiKey({ ...draft, ...patch }, environmentKeys, state.data)
        ?.env !== key
    ) {
      const environment = { ...(patch.environment ?? draft.environment) };
      if (typeof environment[key] === "string") {
        delete environment[key];
        onChange({ ...patch, environment });
        return;
      }
    }
    onChange(patch);
  };
  const apiKeyFields = apiKey && (
    <div className="space-y-2">
      <ProviderApiKeyField
        key={`${draft.command}-${gooseProvider ?? draft.provider}`}
        apiKey={apiKey}
        value={draft.environment[apiKey.env]}
        saved={savedKey}
        disabled={disabled}
        emptyPlaceholder={
          buzzAgent
            ? "Paste API key"
            : pi
              ? "Paste API key or use an existing Pi sign-in"
              : "Paste API key or use existing Goose credentials"
        }
        onChange={(value) => {
          const environment = { ...draft.environment };
          if (value) environment[apiKey.env] = value;
          else delete environment[apiKey.env];
          change({ environment });
        }}
      />
      <p className="text-body-sm text-secondary">
        {apiKey.env}{" "}
        {buzzAgent
          ? "is required for OpenAI. Leave blank to keep a saved key, if present, or use one from Agent defaults."
          : `is used for this agent and model lookup. Leave blank to keep a saved key, if present, or use ${pi ? "your Pi sign-in" : "Goose credentials"}.`}{" "}
        Keys exported in your shell profile are not used. Saved keys are stored
        in this device’s local agent settings files.
      </p>
    </div>
  );
  const renderSections = (model: ReactNode, advanced: ReactNode) =>
    quickModelOnly ? (
      model
    ) : (
      <>
        <div
          hidden={!!modelTarget && !showOptions}
          className={cardLayout ? "agent-create-fields" : undefined}
        >
          <fieldset className="min-w-0 space-y-4">
            <legend
              className={
                showOptions && !cardLayout ? "mb-4 text-label" : "sr-only"
              }
            >
              AI configuration
            </legend>
            <div hidden={!showOptions} className="space-y-4">
              <AgentHarnessEditor
                hideSetupHints={cardLayout}
                disabled={disabled}
                draft={draft}
                options={state.data?.harnessOptions ?? []}
                defaultProvider={defaultProvider}
                piProviders={piProviders}
                onChange={change}
                onProviderSelected={() =>
                  setProviderSelection((value) => value + 1)
                }
                onOpenHarnesses={onOpenHarnesses}
                discardEdits={discardEdits}
              />
              {buzzAgent && windows && (
                <p className="text-body-sm text-secondary">
                  Shell setup not verified. On Windows, the shell tool needs Git
                  Bash from Git for Windows, or a shell set with BUZZ_SHELL
                  under Advanced → Environment. Buzz does not check this before
                  starting.
                </p>
              )}
              {buzzAgent && windows && databricks && (
                <p role="status" className="text-body-sm text-secondary">
                  Databricks sign-in is not supported on Windows yet. Choose
                  OpenAI for this agent.
                </p>
              )}
              {goose && gooseProvider === null && (
                <p role="status" className="text-body-sm text-secondary">
                  This agent has a saved GOOSE_PROVIDER override whose value is
                  hidden. Replace or remove it under Advanced → Environment to
                  enter the matching API key here.
                </p>
              )}
              {apiKeyFields}
            </div>
            {modelTarget && !customize
              ? createPortal(model, modelTarget)
              : model}
            {showOptions && (
              <Select
                label="Conversation context"
                variant="field"
                disabled={disabled}
                value={draft.sessionPolicy ?? ""}
                groups={[
                  {
                    label: "",
                    options: [
                      {
                        value: "",
                        label: `Use agent defaults (${state.data?.defaultSettings?.sessionPolicy === "channel" ? "Entire channel" : "Each thread"})`,
                      },
                      { value: "channel", label: "Entire channel" },
                      { value: "thread", label: "Each thread" },
                    ],
                  },
                ]}
                onValueChange={(sessionPolicy) =>
                  onChange({
                    sessionPolicy:
                      sessionPolicy === ""
                        ? null
                        : (sessionPolicy as "channel" | "thread"),
                  })
                }
                description="Entire channel shares one conversation across threads. Each thread keeps a separate conversation; direct messages remain shared."
              />
            )}
            {showOptions && pi && (
              <p className="text-body-sm text-secondary">
                Providers and models load from your local Pi configuration,
                including extensions. To use a provider that isn’t signed in,
                choose it and add its API key. Save restarts a running agent to
                apply changes.
              </p>
            )}
          </fieldset>
        </div>
        <div
          hidden={!showOptions}
          className={cardLayout ? "agent-create-fields" : undefined}
        >
          {advanced ?? <h3 className="mb-2 text-label">Advanced</h3>}
          <div className="-mx-2">
            <Accordion
              variant="form"
              keepMounted
              items={[
                {
                  value: "advanced",
                  title: "Environment",
                  content: (
                    <div className="space-y-4">
                      <Field label="Workspace">
                        <Input
                          value={draft.workspace}
                          disabled={disabled}
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({ workspace: event.target.value })
                          }
                        />
                      </Field>
                      {!codex && (
                        <Field label="Arguments (JSON array)">
                          <Textarea
                            rows={3}
                            value={draft.args}
                            disabled={disabled}
                            onChange={(event) =>
                              onChange({ args: event.target.value })
                            }
                          />
                        </Field>
                      )}
                      <AgentEnvironmentEditor
                        keys={environmentKeys}
                        patch={draft.environment}
                        disabled={disabled}
                        onChange={(environment) => change({ environment })}
                      />
                      <p className="text-body-sm text-secondary">
                        {pi
                          ? 'Pi needs both Provider and Model to override its defaults. Advanced Pi options follow --; for example: ["--", "--extension", "/absolute/path/to/extension.ts"]. PI_CODING_AGENT_DIR can select a local Pi configuration directory.'
                          : preset
                            ? `Configure ${preset.label}'s model and sign-in in the harness itself. Buzz model and provider overrides are unavailable.`
                            : "Environment overrides take precedence over provider and model selections."}{" "}
                        Arguments are passed literally, not through a shell.
                      </p>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </>
    );
  const nameField = (
    <Field label="Name" labelVisibility={cardLayout ? "hidden" : "visible"}>
      <Input
        disabled={disabled}
        placeholder={cardLayout ? "Name your agent" : undefined}
        value={draft.name}
        onChange={(event) => onChange({ name: event.target.value })}
      />
    </Field>
  );
  return (
    <div
      ref={fields}
      className="min-w-0 space-y-section-gap"
      hidden={
        cardLayout &&
        hideName &&
        hideInstructions &&
        !!modelTarget &&
        !showOptions &&
        !state.data?.agentDefaults?.ownerOnly
      }
    >
      {cardLayout && !hideName && (
        <div className="agent-create-title">{nameField}</div>
      )}
      {((!cardLayout && !hideName) || !hideInstructions) && (
        <div className="space-y-4">
          {!cardLayout && !hideName && nameField}
          {!hideInstructions &&
            (cardLayout ? (
              <AgentInstructions
                onBusyChange={onInstructionBusyChange}
                disabled={disabled}
                value={draft.systemPrompt}
                onChange={(systemPrompt) => onChange({ systemPrompt })}
              />
            ) : (
              <Field label="Agent instructions">
                <Textarea
                  value={draft.systemPrompt}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ systemPrompt: event.target.value })
                  }
                />
              </Field>
            ))}
        </div>
      )}
      {state.data?.agentDefaults?.ownerOnly && (
        <p className="text-body-sm text-secondary">
          This build allows instructions only from the owner and verified
          same-owner agents.
        </p>
      )}
      {preset ? (
        renderSections(
          <div className="space-y-3 text-body-sm">
            <p className="m-0 text-secondary">
              {preset.label} uses its own default model and sign-in.{" "}
              <PresetSetupHint hint={preset.setupHint} />
            </p>
            {(draft.model || draft.provider) && (
              <div className="space-y-3">
                <p role="alert">
                  This agent has model or provider settings that Buzz cannot
                  apply to {preset.label} yet. Use {preset.label} defaults
                  before saving or starting.
                </p>
                {draft.model && (
                  <p>
                    Current model: <code>{draft.model}</code>
                  </p>
                )}
                {draft.provider && (
                  <p>
                    Current provider: <code>{draft.provider}</code>
                  </p>
                )}
                <Button
                  disabled={disabled}
                  onClick={() => change({ model: "", provider: "" })}
                >
                  Use {preset.label} defaults
                </Button>
              </div>
            )}
          </div>,
          null,
        )
      ) : codex ? (
        renderSections(
          <CodexConfigurationFields
            id={id}
            savedRevision={savedRevision}
            draft={draft}
            control={control}
            disabled={disabled}
            onChange={change}
          />,
          null,
        )
      ) : (
        <AgentModelPicker
          integration={integration}
          compact={cardLayout && !customize}
          feedbackInPopup={quickModelOnly}
          catalogProvider={buzzProvider ?? undefined}
          onAdvanced={
            cardLayout && !quickModelOnly
              ? () => setCustomize(!customize)
              : undefined
          }
          advancedOpen={customize}
          renderSections={renderSections}
          policy={policy}
          providerSelection={providerSelection}
          onPiProviders={setPiProviders}
          disabled={disabled}
          id={id}
          savedRevision={savedRevision}
          control={control}
          defaults={state.data?.databricksDefaults}
          defaultModel={defaultModel}
          inheritedWorkspace={inheritedWorkspace}
          draft={draft}
          onChange={change}
        />
      )}
    </div>
  );
}
