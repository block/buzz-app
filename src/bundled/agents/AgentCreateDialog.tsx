// Avatar selection above the agent identity and type-owned setup fields.
import { useId, useRef, useState } from "react";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
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

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Use each registered provider's icon in creation and library cards. */
export function TypeIcon({ type }: { type: RegisteredAgentType | undefined }) {
  const Icon = type?.icon ?? RobotIcon;
  return <Icon size={16} aria-hidden="true" />;
}

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
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
}) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AvatarSelection>(() => ({
    kind: "gloopie",
    picture: randomAgentAvatar().url,
  }));
  const [typeKey, setTypeKey] = useState(types[0]?.key ?? "");
  const type = types.find((item) => item.key === typeKey) ?? types[0];
  const [config, setConfig] = useState(() => startingConfig(type));
  const [configRevision, setConfigRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
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
  const close = () => setOpen(false);
  const chooseModel = (item: RegisteredAgentType, next: unknown) => {
    setTypeKey(item.key);
    setConfig(
      next && typeof next === "object" && "instructions" in next
        ? { ...next, instructions: "" }
        : next,
    );
    setConfigRevision((revision) => revision + 1);
    setDirty(true);
    setError("");
  };
  const choose = (key: string) => {
    const item = types.find((candidate) => candidate.key === key);
    if (item && key !== type?.key) chooseModel(item, startingConfig(item));
  };
  const create = async () => {
    if (!type || pending || avatarBusy) return;
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
      const agent = await agents.create({
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(config !== undefined ? { config } : {}),
      });
      onCreated(agent);
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title="Create agent"
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
          disabled={avatarBusy || pending || !type}
        >
          Create agent
        </Button>
      }
    >
      <form
        id={form}
        className={styles.form}
        aria-label="New agent"
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
                  ? "Add a name to create your agent"
                  : undefined
              }
            >
              <div ref={nameControl}>
                <Input
                  ref={nameField}
                  placeholder="Name"
                  value={name}
                  disabled={pending || avatarBusy}
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
          {Create ? (
            <Create
              key={`${type.key}:${configRevision}`}
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
          <section
            aria-label="AI configuration"
            className={styles.configuration}
          >
            <SettingsGroup>
              <PreferenceRow
                title="Harness"
                trailing={
                  <Select
                    label="Harness"
                    variant="compact"
                    align="end"
                    value={type?.key ?? ""}
                    disabled={pending || types.length < 2}
                    groups={[
                      {
                        label: "",
                        options: types.map((item) => ({
                          value: item.key,
                          label: item.remote
                            ? `${item.title} (hosted)`
                            : item.title,
                        })),
                      },
                    ]}
                    onValueChange={choose}
                  />
                }
              />
              {Model && (
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
              )}
            </SettingsGroup>
          </section>
        </div>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
