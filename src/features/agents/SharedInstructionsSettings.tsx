import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { AgentStore } from "./store";
import {
  readSharedInstructions,
  saveSharedInstructions,
  SHARED_INSTRUCTIONS_LIMIT,
  sharedInstructionsKey,
} from "./shared-instructions";

/** Keyed by owner by the Settings host, so drafts never cross accounts. */
export function SharedInstructionsSettings({
  storage,
  owner,
  onUnsavedChange,
}: {
  storage: AgentStore;
  owner: string;
  onUnsavedChange?: ((unsaved: boolean) => void) | undefined;
}) {
  const [draft, setDraft] = useState(() => {
    try {
      return readSharedInstructions(storage, owner);
    } catch {
      return "";
    }
  });
  const [stored, setStored] = useState<string>();
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => storage.read(sharedInstructionsKey(owner)))
      .then(
        (text) => {
          if (!live) return;
          setStored(text ?? "");
          setDraft(text ?? "");
        },
        () => {
          if (live)
            setError("Couldn’t read shared instructions on this device.");
        },
      )
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [storage, owner]);
  const dirty = stored === undefined ? edited : draft.trim() !== stored;
  useEffect(() => {
    // A dispatched Save continues after Settings closes, as Profile's does.
    if (!dirty || busy) return;
    onUnsavedChange?.(true);
    return () => onUnsavedChange?.(false);
  }, [dirty, busy, onUnsavedChange]);
  const save = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const value = await saveSharedInstructions(storage, owner, text);
      setStored(value);
      setDraft(value);
      setSaved(true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Couldn’t save shared instructions on this device. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-section-gap">
      <InlineHeader title="Shared instructions" />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft);
        }}
      >
        <SettingsGroup layout="form">
          <Field
            label="Instructions for your local agents"
            error={error}
            description="Adds to each agent’s own instructions across your communities on this device. Active work keeps its current instructions; changes apply at the next session refresh or new turn."
          >
            <Textarea
              value={draft}
              rows={6}
              maxLength={SHARED_INSTRUCTIONS_LIMIT}
              disabled={busy}
              appearance="outlined"
              onChange={(event) => {
                setDraft(event.target.value);
                setEdited(true);
                setError("");
                setSaved(false);
              }}
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              disabled={busy || (!stored && !draft && !error)}
              onClick={() => void save("")}
            >
              Clear
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={busy || (!dirty && !error)}
            >
              Save
            </Button>
          </div>
          {saved && (
            <p role="status" className="m-0 text-body-sm text-muted">
              Shared instructions saved on this device.
            </p>
          )}
        </SettingsGroup>
      </form>
    </div>
  );
}
