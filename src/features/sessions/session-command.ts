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

/** Host-only; excluded from the public conversation.ui Composer. */
export type SessionCommandHandler = {
  locked: boolean;
  generation: number;
  notice: import("react").ReactNode;
  bindEditor(clear: (expected: MentionDraft) => boolean): () => void;
  submit(raw: MentionDraft, generation: number): Promise<void>;
};
