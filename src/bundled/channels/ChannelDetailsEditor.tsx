import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./Channels.module.css";

/** The capability owns writes; this view owns only a destination-bound editable draft. */
export function ChannelDetailsEditor({
  capability,
  channel,
}: {
  capability: ChannelDetailsCapability;
  channel: ChannelSummary;
}) {
  const id = channel.id;
  const attempt = useSyncExternalStore(capability.subscribe, () =>
    capability.snapshot(id),
  );
  const initial = () => ({
    capability,
    id,
    loading: true,
    editing: false,
    error: "",
    base: undefined as ChannelDetails | undefined,
    draft: undefined as ChannelDetailsDraft | undefined,
  });
  const [state, setState] = useState(initial);
  // Discard drafts during render, not a frame after retargeting to another identity.
  const matches = state.capability === capability && state.id === id;
  if (!matches) setState(initial());
  const view = matches ? state : initial();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnToEdit = useRef(false);
  const patch = useCallback(
    (next: Partial<typeof state>) =>
      setState((old) =>
        old.capability === capability && old.id === id
          ? { ...old, ...next }
          : old,
      ),
    [capability, id],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      patch({ loading: true, error: "" });
      try {
        const base = await capability.load(id, signal);
        if (!signal.aborted) patch({ base });
      } catch (error) {
        if (!signal.aborted)
          patch({
            base: undefined,
            error: String(error instanceof Error ? error.message : error),
          });
      } finally {
        if (!signal.aborted) patch({ loading: false });
      }
    },
    [capability, id, patch],
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    busy.current = false;
    returnToEdit.current = false;
    void load(controller.signal);
    return () => {
      controller.abort();
    };
    // The owner and destination, not metadata updates, define this editor lifetime.
  }, [load]);
  useEffect(() => {
    if (view.editing) nameInput.current?.focus();
  }, [view.editing]);
  useEffect(() => {
    if (
      !view.editing &&
      !view.loading &&
      view.base?.canEdit &&
      returnToEdit.current &&
      editButton.current
    ) {
      returnToEdit.current = false;
      editButton.current.focus();
    }
  }, [view.editing, view.loading, view.base]);
  const draft = attempt?.draft ?? view.draft;
  const locked = view.loading || !!attempt;
  const canEdit = !!view.base?.canEdit;
  const edit = () => {
    if (view.base) patch({ editing: true, draft: view.base, error: "" });
  };
  async function save() {
    const controller = lifetime.current;
    if (
      busy.current ||
      locked ||
      !view.base ||
      !draft ||
      !canEdit ||
      !controller
    )
      return;
    busy.current = true;
    patch({ error: "" });
    try {
      await capability.save(
        view.base,
        { ...draft, name: draft.name.trim().replace(/^#+/, "").trim() },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      returnToEdit.current = true;
      patch({ editing: false, draft: undefined });
      await load(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!controller.signal.aborted) busy.current = false;
    }
  }
  async function check() {
    const controller = lifetime.current;
    if (!controller || busy.current) return;
    busy.current = true;
    patch({ loading: true, error: "" });
    try {
      await capability.check(id, controller.signal);
      if (controller.signal.aborted) return;
      returnToEdit.current = true;
      patch({ editing: false, draft: undefined });
      await load(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        patch({ loading: false });
      }
    }
  }
  return (
    <section className={styles.detailsEditor} aria-label="Edit channel details">
      {(view.editing || attempt) && draft ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Name" description="Up to 120 characters.">
            <Input
              ref={nameInput}
              required
              value={draft.name}
              disabled={locked || !canEdit}
              onChange={(event) =>
                patch({ draft: { ...draft, name: event.target.value } })
              }
            />
          </Field>
          <Field label="Description" description="Up to 1,000 characters.">
            <Textarea
              rows={3}
              value={draft.description}
              disabled={locked || !canEdit}
              onChange={(event) =>
                patch({ draft: { ...draft, description: event.target.value } })
              }
            />
          </Field>
          {view.base?.visibility === "public" ? (
            <Select
              label="Visibility"
              variant="field"
              value={draft.visibility}
              disabled={locked || !canEdit}
              groups={[
                {
                  label: "",
                  options: [
                    { value: "public", label: "Public" },
                    { value: "private", label: "Private" },
                  ],
                },
              ]}
              onValueChange={(value) =>
                patch({
                  draft: {
                    ...draft,
                    visibility: value === "private" ? "private" : "public",
                  },
                })
              }
            />
          ) : (
            <p>Private · This channel cannot be made public here.</p>
          )}
          {view.base?.visibility === "public" &&
            draft.visibility === "private" && (
              <p>
                Saving makes this channel invite-only. Existing members keep
                access; people outside the channel lose access. You cannot make
                it public again here.
              </p>
            )}
          {!attempt && (
            <div className={styles.detailsActions}>
              <Button
                type="submit"
                variant="primary"
                disabled={locked || !canEdit}
              >
                Save
              </Button>
              <Button
                type="button"
                onClick={() => {
                  returnToEdit.current = true;
                  patch({ editing: false, draft: undefined, error: "" });
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </form>
      ) : (
        canEdit &&
        !view.loading && (
          <Button ref={editButton} type="button" onClick={edit}>
            Edit details
          </Button>
        )
      )}
      {attempt?.status === "saving" && (
        <p role="status">Saving channel details…</p>
      )}
      {attempt?.status === "unconfirmed" && (
        <>
          <p role="status">
            The change may have been saved. Check its status before trying
            again. Checking never resends it.
          </p>
          <Button
            type="button"
            disabled={view.loading}
            onClick={() => void check()}
          >
            Check save status
          </Button>
        </>
      )}
      {!attempt && view.loading && (
        <p role="status">Checking channel permissions…</p>
      )}
      {!attempt && !view.loading && view.base && !canEdit && (
        <p>Only current channel owners and admins can edit these details.</p>
      )}
      {view.error && <p role="alert">{view.error}</p>}
      {!attempt && view.error && (
        <Button
          type="button"
          disabled={view.loading}
          onClick={() => {
            if (lifetime.current) void load(lifetime.current.signal);
          }}
        >
          Reload details
        </Button>
      )}
    </section>
  );
}
