import type {
  DocumentEditorHandle,
  DocumentEditorProps,
} from "../../plugins/author";
import { MAX_NOTE_BYTES } from "./model";
import { usePagesUi } from "./ui";

export type NoteEditorHandle = DocumentEditorHandle;
export function NoteEditor(props: Omit<DocumentEditorProps, "maxLength">) {
  const Editor = usePagesUi().conversation.DocumentEditor;
  return (
    <Editor
      {...props}
      maxLength={MAX_NOTE_BYTES}
      label="Doc body"
      placeholder="Write your doc…"
    />
  );
}
