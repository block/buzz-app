import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { EditableInput } from "./EditableInput";
import { ComposerFormattingTools } from "./ComposerFormattingTools";
import { ComposerLinkDialog } from "./ComposerLinkDialog";
import type {
  ComposerFormat,
  ComposerInputElement,
  ComposerLinkEdit,
} from "./composer-dom";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  documentEditorDraft,
  documentEditorMarkdown,
} from "./document-editor-markdown";
import styles from "./DocumentEditor.module.css";

const noDecorations = () => [];

export type DocumentEditorSelection = {
  start: number;
  end: number;
  source: boolean;
};
export type DocumentEditorHandle = {
  focusEnd(): void;
  selection(): DocumentEditorSelection | undefined;
  focusSelection(selection: DocumentEditorSelection): void;
};

export type DocumentEditorProps = {
  ref?: Ref<DocumentEditorHandle>;
  value: string;
  editing: boolean;
  children?: ReactNode;
  onChange(value: string): void;
  disabled?: boolean;
  destinations?: readonly { label: string; href: string }[];
  label?: string;
  placeholder?: string;
  maxLength: number;
  linkOpen: boolean;
  onLinkOpenChange(open: boolean): void;
  onSave(): void;
  toolbarTarget?: HTMLElement | null;
  source: boolean;
  onSourceChange(source: boolean): void;
};

/** A document body using the composer's editing engine, without chat behavior. */
export function DocumentEditor({
  ref,
  value,
  editing,
  children,
  onChange,
  disabled = false,
  destinations,
  label = "Document body",
  placeholder = "Write…",
  maxLength,
  linkOpen,
  onLinkOpenChange,
  onSave,
  toolbarTarget = null,
  source,
  onSourceChange,
}: DocumentEditorProps) {
  const input = useRef<ComposerInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      selection() {
        const field = source ? sourceInput.current : input.current;
        if (!field?.contains(document.activeElement)) return;
        return { start: field.selectionStart, end: field.selectionEnd, source };
      },
      focusSelection(selection) {
        if (!editing || disabled) return;
        const field = source ? sourceInput.current : input.current;
        field?.focus();
        field?.setSelectionRange(selection.start, selection.end);
      },
      focusEnd() {
        if (!editing || disabled) return;
        const field = source ? sourceInput.current : input.current;
        if (!field) return;
        const end = field.value.length;
        field.focus();
        field.setSelectionRange(end, end);
      },
    }),
    [editing, disabled, source],
  );
  const [draft, setDraft] = useState(() => documentEditorDraft(value));
  const [formats, setFormats] = useState<readonly ComposerFormat[]>([]);
  const [link, setLink] = useState<ComposerLinkEdit>();
  const emitted = useRef(value);
  const syncing = useRef(false);
  const accepted = useRef<
    | {
        value: string;
        draft: typeof draft;
        restore(): void;
      }
    | undefined
  >(undefined);
  const rememberAccepted = () => {
    if (
      !source &&
      !syncing.current &&
      emitted.current === value &&
      input.current
    )
      accepted.current = { value, draft, restore: input.current.checkpoint() };
  };
  // A rich edit renders even when its onChange is declined. Reconcile every
  // committed render so only accepted content survives, before the next paint.
  useLayoutEffect(() => {
    syncing.current = false;
    if (source) return;
    if (value === emitted.current) {
      rememberAccepted();
      return;
    }
    emitted.current = value;
    syncing.current = true;
    const previous = accepted.current;
    if (previous?.value === value) {
      // Restore the accepted document, selection and undo state without an edit
      // transaction that could normalize Markdown or notify the plugin again.
      previous.restore();
      setDraft(previous.draft);
    } else setDraft(documentEditorDraft(value));
  });
  useLayoutEffect(() => {
    // The engine emits native select events even when formatting is unchanged.
    const field = input.current;
    field?.addEventListener("select", rememberAccepted);
    return () => field?.removeEventListener("select", rememberAccepted);
  });
  useEffect(() => {
    if (!linkOpen) {
      setLink(undefined);
      return;
    }
    if (source) onSourceChange(false);
    setLink((old) => old ?? input.current?.editLink() ?? undefined);
  }, [linkOpen, source, onSourceChange]);
  const editLink = (edit?: ComposerLinkEdit) => {
    const next = edit ?? input.current?.editLink();
    if (!next) return;
    setLink(next);
    onLinkOpenChange(true);
  };
  const toolbar = (
    <fieldset className={styles.editorToolbar} aria-label="Document formatting">
      <ComposerFormattingTools
        persistent
        disabled={disabled || !editing}
        activeFormats={formats}
        toggleFormat={(format) => input.current?.toggleFormat(format)}
        editLink={() => editLink()}
      >
        {null}
      </ComposerFormattingTools>
    </fieldset>
  );
  return (
    <div
      className={`${styles.stack} ${editing && source ? styles.sourceEditor : ""}`}
    >
      {editing &&
        !source &&
        (toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar)}
      <section className={styles.editorBody} aria-label="Document content">
        <div hidden={!editing}>
          {source ? (
            <Textarea
              ref={sourceInput}
              aria-label="Markdown"
              value={value}
              rows={4}
              maxLength={maxLength}
              variant="code"
              disabled={disabled || !editing}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onSave();
                }
              }}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
          ) : (
            <div className="text-body">
              <EditableInput
                ref={input}
                draft={draft}
                value={draft.text}
                disabled={disabled || !editing}
                placeholder={placeholder}
                aria-label={label}
                maxLength={maxLength}
                markdownMode="document"
                decorationsFor={noDecorations}
                onDraftChange={(next) => {
                  if (syncing.current) return;
                  setDraft(next);
                  const markdown = documentEditorMarkdown(next);
                  if (markdown !== value) {
                    emitted.current = markdown;
                    onChange(markdown);
                  }
                }}
                onFormatsChange={setFormats}
                onEditLink={editLink}
                onKeyDown={(event) => {
                  if (
                    !event.defaultPrevented &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.altKey &&
                    !event.shiftKey &&
                    event.key.toLowerCase() === "k"
                  ) {
                    event.preventDefault();
                    editLink();
                  }

                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.metaKey || event.ctrlKey) onSave();
                    else
                      input.current?.insertLineBreak(
                        event.shiftKey ? "hard" : "paragraph",
                      );
                  }
                  if (
                    destinations?.length &&
                    event.key === "[" &&
                    input.current?.value[input.current.selectionStart - 1] ===
                      "["
                  ) {
                    event.preventDefault();
                    const start = input.current.selectionStart - 1;
                    input.current.setSelectionRange(
                      start,
                      input.current.selectionEnd,
                    );
                    const next = input.current.editLink();
                    if (next) editLink({ ...next, text: "" });
                  }
                }}
              />
            </div>
          )}
        </div>
        {!editing && children}
      </section>
      {editing && linkOpen && link && (
        <ComposerLinkDialog
          edit={link}
          input={input}
          disabled={disabled || !editing}
          destinations={destinations}
          limitLabel="document"
          close={() => onLinkOpenChange(false)}
        />
      )}
    </div>
  );
}
