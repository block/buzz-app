import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Attachment,
  ChannelMessage,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  normalizeShortcode,
  suggestShortcode,
} from "../../features/relay/emoji";
import { isNativeMediaSource } from "../../features/messages/attachment-source";
import { prepareAttachment } from "../../features/messages/prepare-attachment";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { liftSubject } from "./lift-subject";
import styles from "./Emoji.module.css";

/** The first image a sticker can be made from. */
export function stickerSource(message: ChannelMessage): Attachment | undefined {
  return message.attachments.find(
    (attachment) =>
      attachment.kind === "image" && attachment.mime !== "image/svg+xml",
  );
}

type Lift =
  | { status: "lifting" }
  | { status: "lifted"; png: Blob; preview: string }
  | { status: "unavailable"; reason?: string | undefined };

/** Turns a message image into a custom emoji, lifting its subject where the
 * host can, the way Messages makes stickers from photos. */
export function StickerDialog({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const attachment = stickerSource(message);
  const source = attachment && session.media(attachment.url);
  const liftable = !!source && isNativeMediaSource(source);
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
  );
  const [lift, setLift] = useState<Lift>(
    liftable ? { status: "lifting" } : { status: "unavailable" },
  );
  // A lifted subject is a still image, so animated GIFs default to the whole image.
  const [cutout, setCutout] = useState(attachment?.mime !== "image/gif");
  const [name, setName] = useState(
    () => (attachment?.name && suggestShortcode(attachment.name)) || "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void session.emoji.ensure();
  }, [session]);
  useEffect(() => {
    if (!liftable || !source) return;
    let live = true;
    let preview: string | undefined;
    liftSubject(source).then(
      (png) => {
        if (!live) return;
        preview = URL.createObjectURL(png);
        setLift({ status: "lifted", png, preview });
      },
      (reason: unknown) => {
        if (live)
          setLift({
            status: "unavailable",
            reason:
              typeof reason === "string"
                ? reason
                : reason instanceof Error
                  ? reason.message
                  : undefined,
          });
      },
    );
    return () => {
      live = false;
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [liftable, source]);
  useEffect(() => () => controller.current?.abort(), []);

  const { add, upload } = session.emoji;
  const normalized = normalizeShortcode(name);
  const nameInvalid = name.trim().length > 0 && !normalized;
  const replacing =
    !!normalized && catalog.mine.some((e) => e.shortcode === normalized);
  const lifted = lift.status === "lifted" && cutout ? lift : undefined;
  const preview = lifted ? lifted.preview : source;
  const canSave =
    !!add &&
    !!upload &&
    !!attachment &&
    !!normalized &&
    lift.status !== "lifting" &&
    !saving;

  async function save() {
    if (!add || !upload || !attachment || !normalized || !canSave) return;
    const operation = new AbortController();
    controller.current = operation;
    setSaving(true);
    setError("");
    try {
      let url = attachment.url;
      if (lifted) {
        const file = new File([lifted.png], `${normalized}.png`, {
          type: "image/png",
        });
        // The host encodes plain RGBA, so cleaning keeps its exact pixels.
        const prepared = await prepareAttachment(file, operation.signal, true);
        url = (await upload(prepared, operation.signal)).url;
      }
      // A dialog closed mid-upload must not still publish the emoji set.
      operation.signal.throwIfAborted();
      const stored = await add(normalized, url);
      if (!operation.signal.aborted) setAdded(stored);
    } catch (reason) {
      if (!operation.signal.aborted)
        setError(
          reason instanceof Error && reason.message
            ? reason.message
            : "Failed to save sticker.",
        );
    } finally {
      if (controller.current === operation) controller.current = null;
      if (!operation.signal.aborted) setSaving(false);
    }
  }

  const status =
    lift.status === "lifting"
      ? "Lifting the subject…"
      : lift.status === "unavailable" && liftable
        ? `${lift.reason ?? "Couldn't lift a subject"}. You can still use the whole image.`
        : undefined;
  return (
    <>
      {added && (
        <ToastNotice
          title={`Added :${added}:`}
          description="Use it in messages and reactions."
          tone="success"
          timeout={5000}
          onDismiss={close}
        />
      )}
      <Dialog
        size="compact"
        open={!added}
        dismissOnOutsideClick={false}
        onOpenChange={(open) => !open && close()}
        preventClose={saving}
        initialFocus={nameInput}
        title="Make sticker"
        description="Save this image as a custom emoji that everyone in this community can use in messages and reactions."
        actions={
          <>
            <Button disabled={saving} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="prominent"
              loading={saving}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save sticker"}
            </Button>
          </>
        }
      >
        <form
          aria-label="Sticker"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div
            className={styles.stickerPreview}
            aria-busy={lift.status === "lifting"}
          >
            {preview && (
              <img
                alt={lifted ? "Sticker preview" : "Image preview"}
                src={preview}
                draggable={false}
                data-cutout={lifted ? "" : undefined}
                data-lifting={lift.status === "lifting" ? "" : undefined}
              />
            )}
          </div>
          {status && (
            <p role="status" className="text-body-sm text-muted">
              {status}
            </p>
          )}
          {lift.status === "lifted" && (
            <Checkbox
              size="sm"
              label="Remove background"
              checked={cutout}
              disabled={saving}
              onCheckedChange={setCutout}
            />
          )}
          <Field
            label="Give it a name"
            description="Type this name between colons in messages and reactions."
            error={
              nameInvalid
                ? "Use only letters, numbers, hyphen, or underscore."
                : undefined
            }
          >
            <InputGroup leading=":" trailing=":">
              <Input
                ref={nameInput}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="my-sticker"
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </InputGroup>
          </Field>
          {!nameInvalid && replacing && (
            <p className="text-body-sm text-muted">
              You already have :{normalized}: — saving will replace its image.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}
