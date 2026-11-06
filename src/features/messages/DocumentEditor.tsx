import {
  useEffect,
  useImperativeHandle,
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
import { composerMarkdown } from "./composer-markdown";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { documentEditorDraft } from "./document-editor-markdown";
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
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setDraft(documentEditorDraft(value));
  }, [value]);
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
                emitted.current = event.target.value;
                onChange(event.target.value);
                setDraft(documentEditorDraft(event.target.value));
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
                decorationsFor={noDecorations}
                onDraftChange={(next) => {
                  setDraft(next);
                  const markdown = composerMarkdown(next);
                  emitted.current = markdown;
                  onChange(markdown);
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

                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    onSave();
                  }
                  if (
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
