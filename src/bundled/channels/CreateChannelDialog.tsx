import {
  emptyLineup,
  parseLineup,
  type Groups,
  type Group,
} from "../../features/channel-templates/model";
import type {
  TemplateDraft,
  TemplateProviders,
} from "../../features/channel-templates/provider";
import type { ChannelCreationInput } from "../../features/channel-templates/setup";
import type { RelaySession } from "../../features/relay/session";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ChannelDurationField } from "./ChannelDurationField";
import { ChannelTextField } from "./ChannelTextField";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../../features/relay/channel-details-protocol";
import { Switch } from "../../shared/design-system/ui/Switch";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/work-sessions";
import styles from "./CreateChannelDialog.module.css";

export type CreateChannelInput = ChannelCreationInput;

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(input: CreateChannelInput): Promise<void>;
  pending?: CreateChannelInput | undefined;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  session: RelaySession;
  providers: TemplateProviders;
  groups: Groups | undefined;
  destinations?: readonly (Pick<Group, "id" | "name"> & { icon?: string })[];
  groupSource?: "legacy";
  initialGroup: string;
  groupsReady: boolean;
};
export function CreateChannelDialog(props: Props) {
  // Each opening owns its callbacks. Closing/reopening cannot revive an old editor.
  return props.open ? <OpenCreateChannelDialog {...props} /> : null;
}
function OpenCreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
  finalFocus,
  session,
  providers,
  groups,
  destinations = groups?.groups ?? [],
  groupSource,
  initialGroup,
  groupsReady,
}: Props) {
  const available = useSyncExternalStore(
    providers.subscribe,
    providers.snapshot,
  );
  const provider = available.length === 1 ? available[0] : undefined;
  const [initialProvider] = useState(provider);
  const [initialDefault] = useState(() =>
    !pending && provider && !groupSource
      ? (groups?.groups.find((g) => g.id === initialGroup)?.defaultTemplateId ??
        "")
      : "",
  );
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [draft, setDraft] = useState<TemplateDraft | undefined>(() =>
    initialDefault
      ? {
          templateId: initialDefault,
          lineup: emptyLineup(),
          agents: [],
          problem: "Group default is awaiting selection.",
        }
      : undefined,
  );
  const input = useRef<HTMLInputElement>(null);
  const privateControlId = useId();
  const privateSwitch = useRef<HTMLSpanElement>(null);
  const privacyCancel = useRef<HTMLButtonElement>(null);
  const [privacyChoice, setPrivacyChoice] = useState<"private" | "public">();
  const previousPrivacyChoice = useRef(privacyChoice);
  useLayoutEffect(() => {
    if (privacyChoice !== previousPrivacyChoice.current)
      (privacyChoice ? privacyCancel.current : privateSwitch.current)?.focus();
    previousPrivacyChoice.current = privacyChoice;
  }, [privacyChoice]);
  const mounted = useRef(true);
  const previousOpen = useRef(false);
  const previousPending = useRef(pending);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lifetime, setLifetime] = useState<"ongoing" | "temporary">("ongoing");
  const [temporaryTtl, setTemporaryTtl] = useState(
    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const [privateChannel, setPrivateChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [groupId, setGroupId] = useState("");
  const destination = destinations.find((g) => g.id === groupId);
  const summary =
    pending?.setup ?? (draft ? { agents: draft.agents, groupId } : undefined);
  const group = groupSource
    ? undefined
    : groups?.groups.find((g) => g.id === groupId);
  const editing = useRef(false);
  editing.current = !pending && !busy && !privacyChoice;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const opening = open && !previousOpen.current;
    const restoring =
      open && pending !== undefined && previousPending.current === undefined;
    previousOpen.current = open;
    previousPending.current = pending;
    if (!opening && !restoring) return;
    setName(pending?.name ?? "");
    setDescription(pending?.description ?? "");
    setLifetime(pending?.ttlSeconds === undefined ? "ongoing" : "temporary");
    setTemporaryTtl(
      pending?.ttlSeconds ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
    );
    setPrivateChannel(pending?.visibility === "private");
    setPrivacyChoice(undefined);
    setError("");
    setGroupId(pending ? (pending.setup?.groupId ?? "") : initialGroup);
  }, [open, pending, initialGroup]);

  const normalizedName = canonicalDetailsName(name);
  const errors = detailsDraftErrors({
    name: normalizedName,
    description,
    visibility: privateChannel ? "private" : "public",
  });
  // Recovery must retain the original frozen request, not reinterpret its fields.
  const invalid = !pending && Object.values(errors).some(Boolean);

  const submit = async () => {
    if (invalid || busy || privacyChoice) return;
    editing.current = false;
    setBusy(true);
    setError("");
    try {
      if (
        !pending &&
        groupId &&
        (!groupsReady || !destinations.some((g) => g.id === groupId))
      )
        throw new Error(
          groupsReady
            ? "This group is no longer available. Close this dialog and create from another sidebar group or Channels."
            : "Wait for saved sidebar groups to load, then try again.",
        );
      if (!pending && draft?.problem) throw new Error(draft.problem);
      const agents = draft?.agents ?? [];
      const canvas = draft?.lineup.canvas ?? "";
      const templateId = draft?.templateId ?? "";
      await onCreate(
        pending ?? {
          name: normalizedName,
          visibility: privateChannel ? "private" : "open",
          ...(lifetime === "temporary" ? { ttlSeconds: temporaryTtl } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(templateId || groupId || agents.length || canvas
            ? {
                setup: {
                  agents,
                  canvas,
                  groupId,
                  templateId,
                  ...(groupId && groupSource ? { groupSource } : {}),
                },
              }
            : {}),
        },
      );
      if (mounted.current) onOpenChange(false);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The channel could not be created.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const recoverySummary = summary && (
    <section aria-label="Channel setup summary">
      <p>
        {summary.agents.length
          ? `${summary.agents.length} selected agent${summary.agents.length === 1 ? "" : "s"}.`
          : "Only you."}
        {summary.groupId &&
          ` Destination: ${destinations.find((g) => g.id === summary.groupId)?.name ?? "saved group"}.`}
      </p>
      {!pending && (
        <>
          <p>
            Your selected setup is retained. Restore Templates &amp; teams to
            edit it, or clear it below.
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditorGeneration((generation) => generation + 1);
              setDraft({ templateId: "", lineup: emptyLineup(), agents: [] });
              setError("");
            }}
          >
            Clear template setup (keep group)
          </Button>
        </>
      )}
    </section>
  );

  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      onOpenChange={(next) => {
        if (!next && privacyChoice) setPrivacyChoice(undefined);
        else onOpenChange(next);
      }}
      step={
        privacyChoice
          ? { key: "privacy", scale: 0.95 }
          : { key: "details", scale: 1.05 }
      }
      headerGap="compact"
      preventClose={busy}
      title={
        privacyChoice ? (
          privacyChoice === "private" ? (
            "Make channel private?"
          ) : (
            "Make channel public?"
          )
        ) : (
          <span className={styles.title}>
            Create a channel
            {groupId && (
              <>
                {" in "}
                {destination?.icon && (
                  <>
                    <SidebarGroupIcon
                      icon={destination.icon}
                      session={session}
                    />{" "}
                  </>
                )}
                {destination?.name ?? "saved group"}
              </>
            )}
          </span>
        )
      }
      description={
        privacyChoice
          ? privacyChoice === "private"
            ? "Only channel members will have access."
            : "Everyone in this community will be able to view this channel’s full history."
          : undefined
      }
      closeLabel={
        privacyChoice ? "Back to channel creation" : "Close channel creation"
      }
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        privacyChoice ? (
          <>
            <Button
              ref={privacyCancel}
              onClick={() => setPrivacyChoice(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="prominent"
              disabled={busy || !!pending}
              onClick={() => {
                if (busy || pending) return;
                setPrivateChannel(privacyChoice === "private");
                setPrivacyChoice(undefined);
                setError("");
              }}
            >
              Continue
            </Button>
          </>
        ) : (
          <>
            <span className={styles.privateAction}>
              <Switch
                id={privateControlId}
                ref={privateSwitch}
                aria-label="Private"
                checked={privateChannel}
                disabled={!!pending}
                readOnly={busy}
                aria-disabled={busy || !!pending || undefined}
                onCheckedChange={(checked) => {
                  if (!editing.current) return;
                  setPrivacyChoice(checked ? "private" : "public");
                }}
              />
              <label className="text-label-sm" htmlFor={privateControlId}>
                Private
              </label>
            </span>
            <Button
              variant="prominent"
              type="submit"
              form="create-channel-form"
              loading={busy}
              disabled={invalid}
            >
              {pending ? "Retry channel" : "Create channel"}
            </Button>
          </>
        )
      }
    >
      {privacyChoice ? (
        <p>This choice takes effect when you create the channel.</p>
      ) : (
        <form
          id="create-channel-form"
          className={styles.form}
          inert={busy}
          aria-busy={busy || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {pending && (
            <p role="status">
              This attempt may already have created a channel. Retry checks it
              first and, if unconfirmed, resends only the same creation request.
              It will not create another channel or continue template setup.
            </p>
          )}
          <fieldset
            disabled={!!pending}
            inert={!!pending}
            style={{ display: "contents", border: 0, padding: 0 }}
          >
            <ChannelTextField
              field="name"
              creation
              inputRef={input}
              value={name}
              error={name ? errors.name : undefined}
              onChange={(value) => {
                setName(value);
                setError("");
              }}
            />
            <ChannelTextField
              field="description"
              value={description}
              error={errors.description}
              onChange={(value) => {
                setDescription(value);
                setError("");
              }}
            />
            {!pending && provider && (
              <OwnedContribution
                key={editorGeneration}
                entry={provider}
                registry={providers}
                fallback={
                  <>
                    <p role="alert">Template controls could not open.</p>
                    {recoverySummary}
                  </>
                }
              >
                {(entry, active) => {
                  const Editor = entry.editor;
                  return (
                    <Editor
                      session={session}
                      value={draft}
                      initialDefault={
                        editorGeneration === 0 && provider === initialProvider
                          ? initialDefault
                          : ""
                      }
                      group={group}
                      active={() =>
                        active() &&
                        mounted.current &&
                        editing.current &&
                        !session.channelCreation.snapshot()
                      }
                      onChange={(value) => {
                        if (
                          !active() ||
                          !mounted.current ||
                          !editing.current ||
                          session.channelCreation.snapshot()
                        )
                          return;
                        try {
                          const lineup = parseLineup(value.lineup);
                          const resolved = parseLineup({
                            teamIds: [],
                            agents: value.agents,
                            canvas: lineup.canvas,
                          });
                          if (
                            typeof value.templateId !== "string" ||
                            (value.templateId &&
                              !/^[a-zA-Z0-9_-]{1,128}$/.test(value.templateId))
                          )
                            throw new Error("Invalid template selection");
                          setDraft({
                            templateId: value.templateId,
                            lineup,
                            agents: resolved.agents,
                            problem: value.problem
                              ? String(value.problem)
                              : undefined,
                          });
                        } catch (reason) {
                          setError(String(reason));
                        }
                      }}
                    />
                  );
                }}
              </OwnedContribution>
            )}
            {!pending && !provider && group?.defaultTemplateId && !draft && (
              <p className="text-secondary">
                Templates &amp; teams is off. This channel will not use the
                group’s saved template default.
              </p>
            )}
            <ChannelDurationField
              temporary={lifetime === "temporary"}
              ttlSeconds={temporaryTtl}
              disabled={!!pending}
              onChange={(ttlSeconds) => {
                if (!editing.current) return;
                setLifetime(ttlSeconds === undefined ? "ongoing" : "temporary");
                if (ttlSeconds !== undefined) setTemporaryTtl(ttlSeconds);
                setError("");
              }}
            />
          </fieldset>
          {!pending && draft?.problem && <p role="alert">{draft.problem}</p>}
          {(pending || !provider) && recoverySummary}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
