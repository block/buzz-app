import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/work-sessions";
import styles from "./CreateChannelDialog.module.css";

export type CreateChannelInput = {
  name: string;
  description?: string;
  visibility: "open" | "private";
  ttlSeconds?: number;
};

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  finalFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(input: CreateChannelInput): Promise<void>;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const privateControlId = useId();
  const mounted = useRef(true);
  const [name, setName] = useState("");
  const [descriptionVisible, setDescriptionVisible] = useState(false);
  const [description, setDescription] = useState("");
  const [lifetime, setLifetime] = useState<"ongoing" | "temporary">("ongoing");
  const [privateChannel, setPrivateChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescriptionVisible(false);
    setDescription("");
    setLifetime("ongoing");
    setPrivateChannel(false);
    setError("");
  }, [open]);
  useEffect(() => {
    if (open && descriptionVisible) descriptionInput.current?.focus();
  }, [descriptionVisible, open]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        name: trimmedName,
        visibility: privateChannel ? "private" : "open",
        ...(lifetime === "temporary"
          ? { ttlSeconds: DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS }
          : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      preventClose={busy}
      title="Create a channel"
      closeLabel="Close channel creation"
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <span className={styles.privateAction}>
            <Switch
              id={privateControlId}
              aria-label="Private"
              checked={privateChannel}
              readOnly={busy}
              aria-disabled={busy || undefined}
              onCheckedChange={(checked) => {
                setPrivateChannel(checked);
                setError("");
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
            disabled={!name.trim()}
          >
            Create channel
          </Button>
        </>
      }
    >
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
        <Field label="Name">
          <Input
            ref={input}
            data-create-channel-name=""
            required
            maxLength={120}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="release-notes"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
        </Field>
        {descriptionVisible ? (
          <Field label="Description">
            <Textarea
              ref={descriptionInput}
              maxLength={1000}
              rows={3}
              placeholder="What this channel is for"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setError("");
              }}
            />
          </Field>
        ) : (
          <span className={styles.descriptionAction}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDescriptionVisible(true)}
            >
              Add a description
            </Button>
          </span>
        )}
        <Field label={<span className="sr-only">Duration</span>}>
          <RadioGroup
            value={lifetime}
            onValueChange={(value) => {
              setLifetime(value);
              setError("");
            }}
          >
            <Radio
              value="ongoing"
              variant="card"
              label="Ongoing"
              description="Keeps its history until you archive it."
            />
            <Radio
              value="temporary"
              variant="card"
              label="Temporary"
              description="Cleans up after 7 days without activity."
            />
          </RadioGroup>
        </Field>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
