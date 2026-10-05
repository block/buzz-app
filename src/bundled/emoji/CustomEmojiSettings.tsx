import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";
import {
  normalizeShortcode,
  suggestShortcode,
} from "../../features/relay/emoji";
import { prepareAttachment } from "../../features/messages/prepare-attachment";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { SmileyIcon } from "../../shared/design-system/icons";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { CustomEmoji } from "./CustomEmoji";
import styles from "./Emoji.module.css";

const message = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message ? reason.message : fallback;

/** Desktop's custom emoji card: each member adds to their own kind-30030 set. */
export function CustomEmojiSettings({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section aria-labelledby="custom-emoji-settings-title">
      <Header
        id="custom-emoji-settings-title"
        title="Custom emoji"
        subtitle={
          <>
            Share custom emoji on this relay. Use <code>:name:</code> in
            messages and reactions.
          </>
        }
      />
      {connection.status === "ready" && (
        <Editor
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          active={active}
        />
      )}
    </section>
  );
}

function Editor({
  session,
  active,
}: {
  session: RelaySession;
  active(): boolean;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
  );
  const { add, upload } = session.emoji;
  const canAuthor = Boolean(add && upload);
  const [tab, setTab] = useState<"add" | "mine">(canAuthor ? "add" : "mine");
  const [name, setName] = useState("");
  const [image, setImage] = useState<{ url: string; filename: string }>();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    return () => {
      if (node.contains(document.activeElement)) pendingFocus.current = true;
    };
  }, []);
  const uploadRef = useCallback((node: HTMLButtonElement | null) => {
    uploadButton.current = node;
    if (!node) return;
    return () => {
      if (node === document.activeElement) pendingFocus.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    // Upload, Clear, Save, and the empty-state action replace focused controls.
    // Focus Upload after it mounts/enables; ordinary tab switches keep tab focus.
    if (pendingFocus.current) uploadButton.current?.focus();
    pendingFocus.current = false;
  });
  const nameRef = useRef(name);
  nameRef.current = name;
  const uploadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void session.emoji.ensure();
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
    };
  }, [session]);
  const live = () => mounted.current && active();
  const normalized = normalizeShortcode(name);
  const nameInvalid = name.trim().length > 0 && !normalized;
  const replacing =
    !!normalized && catalog.mine.some((e) => e.shortcode === normalized);
  const canSubmit = !!add && !!image && !!normalized && !uploading && !saving;

  async function choose(file: File) {
    if (!upload || uploading || saving || !live()) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    setError("");
    try {
      if (!file.type.startsWith("image/"))
        throw new Error("Choose an image file for custom emoji.");
      const prepared = await prepareAttachment(file, controller.signal);
      const result = await upload(prepared, controller.signal);
      if (!live()) return;
      if (!result.type.startsWith("image/"))
        throw new Error("Choose an image file for custom emoji.");
      setImage({ url: result.url, filename: file.name });
      const suggested = suggestShortcode(file.name);
      if (suggested && !nameRef.current.trim()) setName(suggested);
    } catch (reason) {
      if (!controller.signal.aborted && live())
        setError(message(reason, "Failed to upload emoji image."));
    } finally {
      if (uploadController.current === controller)
        uploadController.current = null;
      if (live()) setUploading(false);
    }
  }

  async function save() {
    if (!add || !image || !normalized || !canSubmit) return;
    setSaving(true);
    setError("");
    setAdded(undefined);
    try {
      const stored = await add(normalized, image.url);
      if (!live()) return;
      setName("");
      setImage(undefined);
      setAdded(stored);
    } catch (reason) {
      if (live()) setError(message(reason, "Failed to add emoji."));
    } finally {
      if (live()) setSaving(false);
    }
  }

  const preview = image && session.media(image.url);
  const uploadAction = (
    <Button
      ref={uploadRef}
      loading={uploading}
      disabled={saving}
      onClick={() => input.current?.click()}
    >
      {uploading
        ? "Uploading…"
        : image
          ? "Choose different image"
          : "Upload image"}
    </Button>
  );
  const addPanel = canAuthor ? (
    <form
      aria-label="Add emoji"
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          saveButton.current?.focus();
          void save();
        }
      }}
    >
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload image"
        accept="image/gif,image/png,image/jpeg,image/webp"
        disabled={uploading || saving}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void choose(file);
        }}
      />
      {image ? (
        <SettingsGroup layout="form">
          <div className="grid gap-2">
            <InlineHeader title="Selected image" />
            <div className="flex flex-wrap items-center gap-3">
              {preview && (
                <span className={styles.emojiPreview}>
                  <img
                    alt="Selected custom emoji preview"
                    src={preview}
                    draggable={false}
                  />
                </span>
              )}
              <div className="grid min-w-0 gap-2">
                <p className="truncate text-body-sm">{image.filename}</p>
                {uploadAction}
              </div>
            </div>
          </div>
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
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="party-parrot"
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </InputGroup>
          </Field>
          {image && !nameInvalid && replacing && (
            <p className="text-body-sm text-muted">
              You already have :{normalized}: — saving will replace its image.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {image && (
            <div
              ref={actionsRef}
              className="mt-2 flex flex-wrap items-center justify-end gap-3"
            >
              <Button
                disabled={uploading || saving}
                onClick={() => {
                  setName("");
                  setImage(undefined);
                  setError("");
                }}
              >
                Clear
              </Button>
              <Button
                ref={saveButton}
                type="submit"
                variant="primary"
                loading={saving}
                disabled={uploading || !normalized}
              >
                {saving ? "Saving…" : "Save emoji"}
              </Button>
            </div>
          )}
        </SettingsGroup>
      ) : (
        <EmptyState
          icon={<SmileyIcon />}
          title="Upload an image"
          description="Upload a GIF, PNG, JPEG, or WebP. Square images work best."
          action={uploadAction}
        />
      )}
      {!image && error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  ) : null;
  const minePanel = (
    <div className="grid gap-2">
      {catalog.status === "error" ? (
        <>
          <p role="alert">{catalog.error}</p>
          <Button onClick={() => void session.emoji.refresh()}>
            Retry emoji
          </Button>
        </>
      ) : catalog.status !== "ready" ? (
        <p className="text-body-sm text-muted">Loading…</p>
      ) : !catalog.mine.length ? (
        <EmptyState
          icon={<SmileyIcon />}
          title="No emojis yet"
          description="Add an image to use in messages and reactions."
          action={
            canAuthor && (
              <Button
                onClick={() => {
                  pendingFocus.current = true;
                  setTab("add");
                }}
              >
                Add emoji
              </Button>
            )
          }
        />
      ) : (
        <SettingsGroup>
          <ul className="grid gap-2 py-3">
            {catalog.mine.map((emoji) => (
              <li key={emoji.shortcode} className="flex items-center gap-3">
                <CustomEmoji emoji={emoji} media={session.media} />
                <span className="truncate text-body-sm">
                  :{emoji.shortcode}:
                </span>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </div>
  );
  return (
    <>
      <Tabs
        label="Custom emoji"
        variant="panel"
        value={tab}
        onValueChange={setTab}
        items={[
          ...(canAuthor ? [{ value: "add" as const, label: "Add emoji" }] : []),
          {
            value: "mine",
            label: catalog.mine.length
              ? `My emojis (${catalog.mine.length})`
              : "My emojis",
          },
        ]}
        renderPanel={(value) => (value === "add" ? addPanel : minePanel)}
      />
      {added && (
        <ToastNotice
          title={`Added :${added}:`}
          tone="success"
          timeout={5000}
          onDismiss={() => setAdded(undefined)}
        />
      )}
    </>
  );
}
