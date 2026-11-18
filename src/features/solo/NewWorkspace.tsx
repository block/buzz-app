import { SidebarSectionEmojiInput } from "../../bundled/channels/SidebarSectionEmojiInput";
import type { SidebarSectionDraft } from "../relay/sidebar-preferences";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { RelaySession } from "../relay/session";
import { emptyLineup } from "../channel-templates/model";
import type { Resume } from "../channel-templates/capability";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { DiscardChanges } from "../agents/AgentSaveButton";
import {
  emptyWorkspace,
  projectTemplate,
  projectTemplateId,
  workspaceCanvas,
  type Workspace,
} from "./workspace";
import { WorkspaceFields } from "./WorkspaceFields";
import styles from "./WorkspaceSettings.module.css";

const noSubscription = () => () => {};

/**
 * Creates a workspace with the same starting folders and Canvas that
 * Workspace settings edits. Retrying reuses the same project ID, so a failed
 * defaults save never creates a second project.
 */
export function NewWorkspace({
  session,
  create,
  close,
  onCreated,
  finalFocus,
  moveConversation = false,
}: {
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
  session: RelaySession;
  create(project: SidebarSectionDraft): Promise<unknown>;
  moveConversation?: boolean;
  close(): void;
  onCreated(id: string): void | Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Once publication starts, retries must use the same project and defaults.
  const [submitted, setSubmitted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = useRef(false);
  const defaults = useRef<Resume>({
    enqueued: (eventId) => {
      defaults.current.id = eventId;
    },
  });
  const form = useId();
  const input = useRef<HTMLInputElement>(null);
  const preferences = session.sidebarPreferences;
  const writable = useSyncExternalStore(
    preferences?.subscribe ?? noSubscription,
    () => preferences?.sectionCreationWritable !== false,
  );
  const recovering = useRef(!writable);
  useLayoutEffect(() => {
    if (recovering.current && writable) {
      const field = input.current;
      const dialog = field?.closest('[role="dialog"]');
      const active = field?.ownerDocument.activeElement;
      if (!active || active === dialog || !dialog?.contains(active))
        field?.focus({ preventScroll: true });
    }
    recovering.current = !writable;
  }, [writable]);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !writable || pending.current || conflict) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      // Validate defaults before anything is published.
      const canvas = workspaceCanvas(workspace);
      const template = canvas
        ? projectTemplate(session.scope, await projectTemplateId(id), trimmed, {
            ...emptyLineup(),
            canvas,
          })
        : undefined;
      setSubmitted(true);
      await create({ id, name: trimmed, ...(icon ? { icon } : {}) });
      if (template) {
        // A confirmed save may have reported failure to its caller. Reconcile
        // the existing record before retrying its exact signed outbox intent.
        await session.channelKit.refresh();
        const state = session.channelKit.snapshot();
        if (state.status !== "ready")
          throw new Error(state.error ?? "Workspace defaults are unavailable.");
        const existing = state.entries.find(
          (entry) =>
            entry.record.value.type === "template" &&
            entry.record.value.id === template.id,
        );
        if (
          existing &&
          (existing.record.deleted ||
            JSON.stringify(existing.record.value) !== JSON.stringify(template))
        ) {
          setConflict(true);
          throw new Error(
            "Workspace defaults changed. Close this dialog and review Workspace settings.",
          );
        }
        if (!existing)
          await session.channelKit.save(
            template,
            undefined,
            false,
            undefined,
            defaults.current,
          );
      }
      await onCreated(id);
      close();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Workspace could not be created. Try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // Escape and Close ask before dropping typed fields or a partly created
  // workspace's retry state; Cancel discards. A conflict leaves nothing to keep.
  const dirty =
    !conflict &&
    (submitted ||
      name.trim() !== "" ||
      icon !== "" ||
      workspace.folders.length > 0 ||
      workspace.worktree !== undefined ||
      workspace.canvas.trim() !== "");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (dirty) setConfirmDiscard(true);
        else close();
      }}
      preventClose={busy}
      // A partly created workspace keeps its retry state; never drop it on a stray click.
      dismissOnOutsideClick={false}
      title={moveConversation ? "Move to new workspace" : "New workspace"}
      description="New conversations in this workspace can use its folders and instructions."
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            {submitted ? "Close" : "Cancel"}
          </Button>
          {!conflict && (
            <Button
              form={form}
              type="submit"
              variant="prominent"
              loading={busy}
              disabled={!name.trim() || !writable}
            >
              {submitted
                ? "Retry"
                : moveConversation
                  ? "Create and move"
                  : "Create"}
            </Button>
          )}
        </>
      }
    >
      <form
        id={form}
        className={styles.sections}
        inert={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <SidebarSectionEmojiInput
          session={session}
          scope={session.scope}
          icon={icon}
          onIconChange={setIcon}
          disabled={busy || submitted}
        >
          <Field label="Name">
            <Input
              ref={input}
              required
              disabled={busy}
              readOnly={submitted}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </SidebarSectionEmojiInput>
        <WorkspaceFields
          value={workspace}
          onChange={setWorkspace}
          disabled={busy || submitted}
          instructionScope="workspace"
        />
        {submitted && !busy && !conflict && (
          <p role="status">
            Name, folders and instructions are kept for the retry.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {!writable && !busy && (
          <>
            <p role="status">Saved workspace preferences are unavailable.</p>
            <Button onClick={() => void preferences.refresh()}>
              Retry preferences
            </Button>
          </>
        )}
      </form>
      {confirmDiscard && (
        <DiscardChanges
          description="Your new workspace has unsaved changes."
          onKeep={() => setConfirmDiscard(false)}
          onDiscard={close}
        />
      )}
    </Dialog>
  );
}
