import { EditorState } from "prosemirror-state";
import {
  projectComposerDocument,
  readComposerDocument,
} from "../messages/composer-document";
import { composerMarkdown } from "../messages/composer-markdown";
import {
  mentionDraft,
  replaceMentionDraft,
  type MentionDraft,
} from "../messages/mention-draft";

/** Reserved only in an ordinary channel's host composer. Never infer recipients. */
export function isSessionCommand(text: string) {
  return /^\/session(?:\s|$)/u.test(text);
}
export function sessionCommandDraft(
  input: MentionDraft,
): MentionDraft | undefined {
  if (!isSessionCommand(input.text)) return undefined;
  const prefix = input.text.match(/^\/session\s*/u)?.[0] ?? "";
  return replaceMentionDraft(mentionDraft(input), 0, prefix.length, "");
}

/** Compare editor payloads, including exact recipient intent and rich structure.
 * Plain saved drafts and their hydrated editor documents are equivalent. */
export function sameSessionCommandDraft(
  left: MentionDraft,
  right: MentionDraft,
) {
  const normalized = (value: MentionDraft) => {
    const draft = mentionDraft(value);
    return mentionDraft(
      projectComposerDocument(readComposerDocument(draft, draft.recipients))
        .draft,
    );
  };
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

/** Freeze the rich wire payload only for new commands; old intents keep theirs. */
export function sessionCommandContent(raw: MentionDraft): string {
  const draft = mentionDraft(raw);
  const prefix = draft.text.match(/^\/session\s*/u)?.[0];
  if (!prefix) throw new Error("The saved session command is invalid.");
  const doc = readComposerDocument(draft, draft.recipients);
  const projection = projectComposerDocument(doc);
  const stripped = EditorState.create({ doc }).tr.delete(
    projection.position(0),
    projection.position(prefix.length),
  ).doc;
  return composerMarkdown(projectComposerDocument(stripped).draft);
}

/** Host-only; excluded from the public conversation.ui Composer. */
export type SessionCommandHandler = {
  locked: boolean;
  generation: number;
  notice: import("react").ReactNode;
  bindEditor(clear: (expected: MentionDraft) => boolean): () => void;
  submit(raw: MentionDraft, generation: number): Promise<void>;
};
