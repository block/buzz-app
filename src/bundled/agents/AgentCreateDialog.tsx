// Avatar selection above the agent identity and type-owned setup fields.
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import {
  AISettings,
  runsOnIcon,
  UsesLine,
} from "../../features/agents/AISettings";
import {
  followRecommended,
  pickRecommended,
  recommendedCandidates,
  recommendedNote,
  type RecommendedPick,
  withRecommended,
} from "../../features/agents/recommended";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  NewAgent,
  AgentCreationRequest,
  AgentUpdateRequest,
} from "../../features/agents/service";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentAvatarPicker, type AvatarSelection } from "./AgentAvatarPicker";
import styles from "./AgentCreate.module.css";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useNamePrompt, useShake } from "./useNamePrompt";
import { MigrationPreview } from "./AgentSettingsHost";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// A failed save's error sits below the whole form, often out of view.
const reveal = (element: HTMLElement | null) => {
  if (!element) return;
  element.scrollIntoView({ block: "nearest" });
  const popup = element.closest<HTMLElement>(".buzz-dialog");
  const footer = popup?.querySelector<HTMLElement>(".buzz-dialog-actions");
  if (!popup || !footer) return;
  const covered =
    element.getBoundingClientRect().bottom - footer.getBoundingClientRect().top;
  if (covered > 0) popup.scrollTop += covered;
};

/** Use each registered provider's icon in creation and library cards. */
export function TypeIcon({
  type,
  size = 16,
}: {
  type: RegisteredAgentType | undefined;
  size?: number;
}) {
  const Icon = type?.icon ?? RobotIcon;
  return <Icon size={size} aria-hidden="true" />;
}

const noSubscribe = () => () => {};
const noProvider = () => undefined;

const startingConfig = (type: RegisteredAgentType | undefined) => {
  try {
    return type?.defaults().config;
  } catch {
    return undefined;
  }
};

export function AgentCreateDialog({
  agents,
  types,
  community,
  onClose,
  onCreated,
  request,
  onCreate,
  update,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
  request?: AgentCreationRequest;
  onCreate?(input: NewAgent): Promise<Agent>;
  /** Edits `agent` instead, starting from its settings with the request's
   * changes. */
  update?: Readonly<{
    agent: Agent;
    request: AgentUpdateRequest;
    onSave(input: NewAgent): Promise<void>;
  }>;
}) {
  const edited = update?.agent;
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(
    update ? (update.request.name ?? update.agent.name) : (request?.name ?? ""),
  );
  const [avatar, setAvatar] = useState<AvatarSelection>(() => {
    const picture = update
      ? (update.request.picture ?? update.agent.picture ?? "")
      : request?.picture;
    return picture === undefined
      ? { kind: "gloopie", picture: randomAgentAvatar().url }
      : { kind: "image", picture };
  });
  // A new agent starts on Recommended when this build has candidates and
  // this computer can run one; until that is known, the choice waits.
  const recommendable =
    !update && !request && recommendedCandidates().length > 0;
  const [typeKey, setTypeKey] = useState(
    (update ? (update.request.type ?? update.agent.type) : request?.type) ??
      // Recommended starts on this computer, not a hosted type.
      (recommendable ? types.find((item) => !item.remote) : types[0])?.key ??
      types[0]?.key ??
      "",
  );
  const type = types.find((item) => item.key === typeKey) ?? types[0];
  const migration = (item: RegisteredAgentType | undefined) => {
    if (!edited || !item || item.key === edited.type) return undefined;
    try {
      return agents.previewRetype(edited.key, item.key);
    } catch {
      return undefined;
    }
  };
  /** The agent's settings in `item`, with the requested instructions. */
  const seed = (item: RegisteredAgentType | undefined) => {
    if (!update) return startingConfig(item);
    const { agent, request } = update;
    const config =
      item?.key === agent.type
        ? agent.config
        : (migration(item)?.config ?? startingConfig(item));
    return request.instructions !== undefined && item?.adopt
      ? item.adopt({ instructions: request.instructions }, config)
      : config;
  };
  const [config, setConfig] = useState(() => seed(type));
  const [automatic, setAutomatic] = useState(recommendable);
  const [pick, setPick] = useState<RecommendedPick | null | undefined>(
    recommendable ? undefined : null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read once, as the dialog opens.
  useEffect(() => {
    if (!recommendable) return;
    let current = true;
    void pickRecommended(types).then((found) => {
      if (current) setPick(found ?? null);
    });
    return () => {
      current = false;
    };
  }, []);
  const preview = migration(type);
  const [dirty, setDirty] = useState(Boolean(update));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarRef = useRef<{ prepare(): Promise<string> }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const namePrompt = useNamePrompt(nameField);
  const nameControl = useRef<HTMLDivElement>(null);
  useShake(nameControl, namePrompt.attempts);
  const form = useId();
  const Create = type?.Create;
  const Model = type?.CreateModel;
  const Rows = type?.CreateRows;
  const close = () => setOpen(false);
  const chooseModel = (item: RegisteredAgentType, next: unknown) => {
    setTypeKey(item.key);
    setConfig(next);
    setDirty(true);
    setError("");
  };
  /** `item`'s config for the agent, with what the owner has typed. */
  const carried = (item: RegisteredAgentType) => {
    const next = seed(item);
    // Typed instructions follow a new agent to its new harness.
    const instructions = update
      ? undefined
      : type?.carry?.(config).instructions;
    return instructions && item.adopt
      ? item.adopt({ instructions }, next)
      : next;
  };
  // Once known, Automatic on this computer takes its harness.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Follows only the pick.
  useEffect(() => {
    if (!pick || !automatic || type?.remote) return;
    if (pick.type.key !== type?.key) {
      setTypeKey(pick.type.key);
      setConfig(carried(pick.type));
    }
  }, [pick]);
  const choose = (key: string) => {
    const item = types.find((candidate) => candidate.key === key);
    if (!item || key === type?.key) return;
    chooseModel(item, carried(item));
  };
  /** Automatic, or the harness and model chosen manually. */
  const chooseAutomatic = (on: boolean) => {
    if (on === automatic) return;
    setAutomatic(on);
    setDirty(true);
    setError("");
    // A hosted type picks its own default.
    if (type?.remote) return;
    // While the pick runs, its effect takes the harness once known.
    if (on && pick && pick.type.key !== type?.key)
      chooseModel(pick.type, carried(pick.type));
    // Manual starts from what Automatic picked.
    if (!on && pick && pick.type.key === type?.key)
      setConfig(
        followRecommended(
          withRecommended(config as object),
          config as { model: string; effort: string },
          pick.candidate,
        ),
      );
  };
  // Automatic has nothing to create with until, and unless, a pick is found.
  const waiting = automatic && !type?.remote && !pick;
  // Where it runs: this computer's harnesses, or a hosted provider.
  const local = recommendable ? types.filter((item) => !item.remote) : types;
  const hostedType = recommendable
    ? types.find((item) => item.remote)
    : undefined;
  const hostedState = useSyncExternalStore(
    hostedType?.provider?.subscribe ?? noSubscribe,
    hostedType?.provider?.snapshot ?? noProvider,
  );
  const chooseRunsOn = (key: string) => {
    const item =
      key === hostedType?.key
        ? hostedType
        : (pick?.type ?? local.find((candidate) => !candidate.remote));
    setAutomatic(true);
    if (item && item.key !== type?.key) chooseModel(item, carried(item));
  };
  const create = async () => {
    if (!type || pending || avatarBusy || waiting) return;
    if (!name.trim()) {
      namePrompt.prompt();
      return;
    }
    setPending(true);
    setError("");
    try {
      const picture =
        (await avatarRef.current?.prepare()) ??
        (avatar.kind === "emoji" ? "" : avatar.picture);
      const input = {
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(config !== undefined
          ? {
              config:
                automatic && pick?.type.key === type.key
                  ? withRecommended(config as object)
                  : config,
            }
          : {}),
      };
      if (update) await update.onSave(input);
      else onCreated(await (onCreate ? onCreate(input) : agents.create(input)));
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  const manualSettings = (
    <>
      <PreferenceRow
        title="Harness"
        trailing={
          <Select
            label="Harness"
            variant="compact"
            align="end"
            value={type?.key ?? ""}
            leading={<TypeIcon type={type} size={20} />}
            disabled={pending || local.length < 2}
            groups={[
              {
                label: "",
                options: local.map((item) => ({
                  value: item.key,
                  leading: <TypeIcon type={item} size={20} />,
                  label: item.remote ? `${item.title} (hosted)` : item.title,
                })),
              },
            ]}
            onValueChange={choose}
          />
        }
      />
      {Model &&
        (recommendable ? (
          // Under Manual, a harness's own rows: Provider, Model, Thinking.
          <Model
            key={type.key}
            layout="rows"
            config={config}
            disabled={pending}
            onChange={(next) => chooseModel(type, next)}
          />
        ) : (
          <PreferenceRow
            title="Model"
            trailing={
              <Model
                key={type.key}
                config={config}
                disabled={pending}
                onChange={(next) => chooseModel(type, next)}
              />
            }
          />
        ))}
    </>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title={edited ? `Edit ${edited.name}` : "Create agent"}
      description={
        update
          ? `${update.request.requesterName} proposed these changes. Nothing changes until you save.`
          : request
            ? `${request.requesterName} requested this agent. Review its settings before creating it.`
            : undefined
      }
      size="default"
      height="content"
      chromeSpacing="padded"
      initialFocus={nameField}
      // A started draft only closes from the close button.
      dismissOnOutsideClick={!dirty}
      onEscape={() => {
        if (pending || avatarBusy) return true;
        return dirty || pending;
      }}
      preventClose={pending || avatarBusy}
      actions={
        <Button
          variant="primary"
          type="submit"
          form={form}
          loading={pending}
          disabled={avatarBusy || pending || !type || waiting}
        >
          {update ? "Save changes" : "Create agent"}
        </Button>
      }
    >
      <form
        id={form}
        className={styles.form}
        data-error={error ? "" : undefined}
        aria-label={edited ? `Edit ${edited.name}` : "New agent"}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className={styles.createStack}>
          <section aria-label="Identity" className={styles.profileIdentity}>
            <div>
              <AgentAvatarPicker
                name={name}
                selection={avatar}
                disabled={pending}
                community={community}
                onBusyChange={setAvatarBusy}
                onChange={(selection) => {
                  setAvatar(selection);
                  setDirty(true);
                  setError("");
                }}
                avatarRef={avatarRef}
              />
            </div>
          </section>
          <div>
            <Field
              label="Name"
              error={
                namePrompt.attempts
                  ? update
                    ? "Name the agent"
                    : "Add a name to create your agent"
                  : undefined
              }
            >
              <div ref={nameControl}>
                <Input
                  ref={nameField}
                  placeholder="Name"
                  value={name}
                  disabled={pending}
                  onChange={(event) => {
                    setName(event.target.value);
                    namePrompt.named(event.target.value);
                    setDirty(true);
                    setError("");
                  }}
                />
              </div>
            </Field>
          </div>
          <section
            aria-label="AI configuration"
            className={styles.configuration}
          >
            <SettingsGroup>
              {hostedType && (
                <PreferenceRow
                  icon={runsOnIcon(type?.remote ? type.icon : undefined)}
                  title="Runs on"
                  subtitle={
                    type?.remote
                      ? `${type.title} runs it in the cloud, even when this computer is off.`
                      : "This computer runs the agent while Buzz is open."
                  }
                  trailing={
                    <Select
                      label="Runs on"
                      variant="compact"
                      align="end"
                      value={type?.remote ? type.key : "local"}
                      leading={runsOnIcon(type?.remote ? type.icon : undefined)}
                      disabled={pending}
                      groups={[
                        {
                          label: "",
                          options: [
                            {
                              value: "local",
                              label: "This computer",
                              leading: runsOnIcon(undefined),
                            },
                            {
                              value: hostedType.key,
                              label: hostedState?.unavailable
                                ? `${hostedType.title} (hosted) · Coming soon`
                                : `${hostedType.title} (hosted)`,
                              leading: runsOnIcon(hostedType.icon),
                              disabled: Boolean(hostedState?.unavailable),
                              description:
                                hostedState?.unavailable ??
                                "Runs in the cloud.",
                            },
                          ],
                        },
                      ]}
                      onValueChange={chooseRunsOn}
                    />
                  }
                />
              )}
              {recommendable && type?.remote ? (
                <AISettings
                  automatic={automatic}
                  disabled={pending}
                  onChange={chooseAutomatic}
                  automaticHint={`${type.title} picks its default model and thinking level.`}
                  manualHint={`You choose the ${type.title} model and thinking level.`}
                  summary={
                    Rows ? (
                      // The hosted type shows, and sets, its own default.
                      <Rows
                        key={`${type.key}:automatic`}
                        layout="rows"
                        automatic
                        config={config}
                        disabled={pending}
                        onChange={setConfig}
                      />
                    ) : (
                      `${type.title} picks a good default.`
                    )
                  }
                >
                  {Rows && (
                    <Rows
                      key={type.key}
                      layout="rows"
                      config={config}
                      disabled={pending}
                      onChange={(next) => chooseModel(type, next)}
                    />
                  )}
                </AISettings>
              ) : recommendable ? (
                <AISettings
                  automatic={automatic}
                  disabled={pending}
                  onChange={chooseAutomatic}
                  summary={
                    pick === undefined ? (
                      "Checking this computer…"
                    ) : pick ? (
                      <UsesLine
                        icon={pick.type.icon}
                        title={pick.type.title}
                        candidate={pick.candidate}
                        note={recommendedNote(pick)}
                      />
                    ) : (
                      "Nothing is set up on this computer yet. Choose Manual to pick a harness, or set one up in Settings → Agent setup."
                    )
                  }
                >
                  {manualSettings}
                </AISettings>
              ) : (
                manualSettings
              )}
            </SettingsGroup>
          </section>
          {Create ? (
            <Create
              key={type.key}
              {...(recommendable ? { layout: "rows" as const } : {})}
              config={config}
              disabled={pending}
              onChange={(next) => {
                setConfig(next);
                setDirty(true);
              }}
            />
          ) : (
            <p className="m-0 text-body-sm text-secondary">
              {type?.remote
                ? "Its provider keeps its key and runs it, whether or not this app is open."
                : "Set it up after it is made."}
            </p>
          )}
          {preview && type && (
            <MigrationPreview
              source={types.find((item) => item.key === edited?.type)}
              target={type}
              preview={preview}
              discardDraft={false}
            />
          )}
        </div>
        {error && (
          <p
            key={error}
            ref={reveal}
            role="alert"
            className="m-0 text-body-sm text-danger"
          >
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
