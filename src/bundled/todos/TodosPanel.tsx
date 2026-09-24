import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { ChannelPanelContext } from "../../features/panels/service";
import {
  CaretDownIcon,
  ListChecksIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { readView, writeView } from "../../shared/view-state";
import { addTodo, readTodos, toggleTodo } from "./model";
import styles from "./Todos.module.css";

type Draft = {
  content: string;
  original: string;
  base: string | null;
  input: string;
};
const empty: Draft = { content: "", original: "", base: null, input: "" };
function readDraft(scope: string, key: string): Draft | undefined {
  const value = readView<Partial<Draft> | null>(scope, key, null);
  return value &&
    typeof value.content === "string" &&
    typeof value.original === "string" &&
    typeof value.input === "string" &&
    (value.base === null || typeof value.base === "string")
    ? (value as Draft)
    : undefined;
}
export function TodosPanel({
  canvas,
  context,
  close,
  active,
}: {
  canvas: ChannelCanvas;
  context: ChannelPanelContext;
  close(): void;
  active(): boolean;
}) {
  const key = `todos-draft-v1:${context.channelId}`;
  const [saved] = useState(() => readDraft(context.scope, key));
  const savedDirty = !!saved && saved.content !== saved.original;
  const [draft, setDraft] = useState<Draft>(saved ?? empty);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"load" | "save">();
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const operation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const prefix = useId();
  const focusAfterToggle = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (focusAfterToggle.current) {
      document.getElementById(focusAfterToggle.current)?.focus();
      focusAfterToggle.current = undefined;
    }
  });
  const dirty = draft.content !== draft.original;
  const update = useCallback(
    (next: Draft) => {
      setDraft(next);
      writeView(
        context.scope,
        key,
        next.content !== next.original || next.input ? next : null,
      );
    },
    [context.scope, key],
  );
  const load = useCallback(
    async (replace = false) => {
      if (!active()) return;
      const generation = ++operation.current;
      setBusy("load");
      setError("");
      try {
        const head = await canvas.read(context.channelId);
        if (!active() || generation !== operation.current) return;
        setLoaded(true);
        const alreadySaved = !!saved && saved.content === head?.content;
        const changed =
          !replace &&
          savedDirty &&
          !alreadySaved &&
          saved.base !== (head?.id ?? null);
        setConflict(changed);
        if (changed)
          setError(
            "Canvas changed elsewhere. Your draft is kept. Refresh to review the saved Canvas before saving.",
          );
        if (replace || !savedDirty || alreadySaved)
          update({
            ...empty,
            input: !replace ? (saved?.input ?? "") : "",
            content: head?.content ?? "",
            original: head?.content ?? "",
            base: head?.id ?? null,
          });
      } catch (reason) {
        if (active() && generation === operation.current)
          setError(String(reason));
      } finally {
        if (active() && generation === operation.current) setBusy(undefined);
      }
    },
    [active, canvas, context.channelId, saved, savedDirty, update],
  );
  // The parent keys this editor by session and channel. No background reads or writes.
  useEffect(() => {
    void load();
    return () => {
      operation.current++;
    };
  }, [load]);
  const save = async () => {
    if (!active() || busy || !loaded || !dirty || conflict) return;
    const generation = ++operation.current;
    setBusy("save");
    setError("");
    try {
      const head = await canvas.save(
        context.channelId,
        draft.content,
        draft.base ?? undefined,
      );
      if (!active() || generation !== operation.current) return;
      update({
        ...draft,
        original: head.content,
        content: head.content,
        base: head.id,
      });
    } catch (reason) {
      if (active() && generation === operation.current)
        setError(
          `Todos couldn’t save. Your changes are still here. ${reason instanceof Error ? reason.message : String(reason)}`,
        );
    } finally {
      if (active() && generation === operation.current) setBusy(undefined);
    }
  };
  let parsed: ReturnType<typeof readTodos> | undefined;
  let parseError = "";
  try {
    parsed = readTodos(draft.content);
  } catch (reason) {
    parseError = reason instanceof Error ? reason.message : String(reason);
  }
  const disabled =
    !loaded || !!busy || !canvas.available || !!parseError || conflict;
  const items = parsed?.items ?? [];
  const remaining = items.filter((item) => !item.checked).length;
  const change = (edit: () => string) => {
    if (!active() || disabled) return;
    try {
      update({ ...draft, content: edit() });
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <div data-buzz-ui="" className={styles.panel} aria-busy={!!busy}>
      <PanelHeader
        variant="compact"
        icon={<ListChecksIcon size={18} aria-hidden="true" />}
        title={
          <div className={styles.heading}>
            <h2 className="text-label">Todos</h2>
            <span className="text-caption text-secondary">
              {context.channelName}
            </span>
          </div>
        }
        actions={
          <IconButton
            size="sm"
            variant="ghost"
            icon={<CaretDownIcon size={16} aria-hidden="true" />}
            aria-label="Hide todos"
            title="Hide todos"
            onClick={close}
          />
        }
      />
      <div className={styles.scroll}>
        <div className={styles.content}>
          <form
            className={styles.add}
            onSubmit={(event) => {
              event.preventDefault();
              if (!active() || disabled || !draft.input.trim()) return;
              try {
                update({
                  ...draft,
                  content: addTodo(draft.content, draft.input),
                  input: "",
                });
                setError("");
                input.current?.focus();
              } catch (reason) {
                setError(String(reason));
              }
            }}
          >
            <Field label="New todo" labelVisibility="hidden">
              <Input
                ref={input}
                placeholder="Add a todo…"
                value={draft.input}
                disabled={disabled}
                onChange={(event) =>
                  update({ ...draft, input: event.target.value })
                }
              />
            </Field>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || !draft.input.trim()}
            >
              Add
            </Button>
          </form>
          {(error || parseError) && (
            <p role="alert" className="text-body-sm text-danger">
              {error || parseError}
            </p>
          )}
          {!canvas.available && (
            <p className="text-body-sm text-secondary">
              This connection doesn’t support saving Canvas.
            </p>
          )}
          {!loaded ? (
            <p role="status" className="text-body-sm text-secondary">
              {busy ? "Loading todos…" : "Couldn’t load todos. Try Refresh."}
            </p>
          ) : (
            !parseError && (
              <>
                {items.length === 0 || remaining === 0 ? (
                  <div className={styles.empty}>
                    <p className="text-label">
                      {items.length ? "All done" : "No todos yet"}
                    </p>
                    <p className="text-body-sm text-secondary">
                      {items.length
                        ? "Uncheck an item to move it back."
                        : "Add the first item for this channel."}
                    </p>
                  </div>
                ) : null}
                {[false, true].map((checked) => {
                  const group = items.filter(
                    (item) => item.checked === checked,
                  );
                  return (
                    group.length > 0 && (
                      <section
                        key={String(checked)}
                        className={styles.group}
                        aria-label={checked ? "Completed" : "To do"}
                      >
                        <h3 className="text-label-sm text-secondary">
                          {checked ? "Completed" : "To do"} · {group.length}
                        </h3>
                        <ul className={styles.list}>
                          {group.map((item) => (
                            <li key={item.offset} className={styles.row}>
                              <Checkbox
                                id={`${prefix}-${item.offset}`}
                                checked={item.checked}
                                disabled={disabled}
                                onCheckedChange={(value) => {
                                  focusAfterToggle.current = `${prefix}-${item.offset}`;
                                  change(() =>
                                    toggleTodo(
                                      draft.content,
                                      item.offset,
                                      value,
                                    ),
                                  );
                                }}
                                label={
                                  <span
                                    className={`${styles.label} text-body-sm ${item.checked ? "text-secondary" : ""}`}
                                    data-completed={item.checked || undefined}
                                  >
                                    {item.label}
                                  </span>
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  );
                })}
              </>
            )
          )}
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.summary}>
          <p role="status" className="text-caption">
            {dirty
              ? "Unsaved changes"
              : loaded
                ? "Saved in Canvas"
                : "Channel Canvas"}
          </p>
          <p className="text-caption text-secondary">
            Shared Markdown. Simultaneous saves can overwrite edits.
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant={error ? "prominent" : "subtle"}
            disabled={!!busy}
            onClick={() => {
              if (
                loaded &&
                (dirty || draft.input) &&
                !window.confirm(
                  "Discard your unsaved todo changes and load the saved Canvas?",
                )
              )
                return;
              void load(loaded);
            }}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant={error ? "subtle" : "prominent"}
            loading={busy === "save"}
            disabled={disabled || !dirty}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </footer>
    </div>
  );
}
