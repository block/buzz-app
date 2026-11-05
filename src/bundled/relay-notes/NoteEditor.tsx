import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { EditableInput } from "../../features/messages/EditableInput";
import { ComposerFormattingTools } from "../../features/messages/ComposerFormattingTools";
import { ComposerLinkDialog } from "../../features/messages/ComposerLinkDialog";
import type {
  ComposerFormat,
  ComposerInputElement,
  ComposerLinkEdit,
} from "../../features/messages/composer-dom";
import { composerMarkdown } from "../../features/messages/composer-markdown";
import { MAX_NOTE_BYTES, noteUrl, type Note } from "../../features/notes/model";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { noteEditorDraft } from "./editor-markdown";
import styles from "./WorkingNotes.module.css";

const noDecorations = () => [];

export type NoteSelection = { start: number; end: number; source: boolean };
export type NoteEditorHandle = {
  focusEnd(): void;
  selection(): NoteSelection | undefined;
  focusSelection(selection: NoteSelection): void;
};

/** A document body using the composer's editing engine, without chat behavior. */
export function NoteEditor({
  ref,
  value,
  editing,
  children,
  onChange,
  disabled,
  notes,
  community,
  linkOpen,
  onLinkOpenChange,
  onSave,
  toolbarTarget,
  source,
  onSourceChange,
}: {
  ref?: Ref<NoteEditorHandle>;
  value: string;
  editing: boolean;
  children: ReactNode;
  onChange(value: string): void;
  disabled: boolean;
  notes: readonly Note[];
  community: string;
  linkOpen: boolean;
  onLinkOpenChange(open: boolean): void;
  onSave(): void;
  toolbarTarget: HTMLElement | null;
  source: boolean;
  onSourceChange(source: boolean): void;
}) {
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
  const [draft, setDraft] = useState(() => noteEditorDraft(value));
  const [formats, setFormats] = useState<readonly ComposerFormat[]>([]);
  const [link, setLink] = useState<ComposerLinkEdit>();
  const emitted = useRef(value);
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setDraft(noteEditorDraft(value));
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
  return (
    <div
      className={`${styles.stack} ${editing && source ? styles.sourceEditor : ""}`}
    >
      {editing &&
        !source &&
        toolbarTarget &&
        createPortal(
          <fieldset
            className={styles.editorToolbar}
            aria-label="Page formatting"
          >
            <ComposerFormattingTools
              persistent
              disabled={disabled || !editing}
              activeFormats={formats}
              toggleFormat={(format) => input.current?.toggleFormat(format)}
              editLink={() => editLink()}
            >
              {null}
            </ComposerFormattingTools>
          </fieldset>,
          toolbarTarget,
        )}
      <section className={styles.editorBody} aria-label="Page content">
        <div hidden={!editing}>
          {source ? (
            <Textarea
              ref={sourceInput}
              aria-label="Markdown"
              value={value}
              rows={4}
              textSize="body"
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
                setDraft(noteEditorDraft(event.target.value));
              }}
            />
          ) : (
            <div className="text-body">
              <EditableInput
                ref={input}
                draft={draft}
                value={draft.text}
                disabled={disabled || !editing}
                placeholder="Write your page…"
                aria-label="Page body"
                maxLength={MAX_NOTE_BYTES}
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
          destinations={notes
            .filter((note) => !note.deleted)
            .map((note) => ({
              label: note.title,
              href: noteUrl(note, community),
            }))}
          close={() => onLinkOpenChange(false)}
        />
      )}
    </div>
  );
}
