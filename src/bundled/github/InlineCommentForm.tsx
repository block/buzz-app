import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./InlineComments.module.css";

export function InlineCommentForm({
  operation,
  submitLabel = "Post to GitHub",
  draft,
  focusRequest = 0,
  busy,
  blocked,
  notice,
  onSubmit,
  onCancel,
}: {
  operation?: string;
  submitLabel?: string;
  draft: { body: string; lastFocusRequest?: number };
  focusRequest?: number;
  busy: boolean;
  blocked: boolean;
  notice?: string | undefined;
  onSubmit(body: string): void;
  onCancel(): void;
}) {
  const [body, setBody] = useState(draft.body);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (draft.lastFocusRequest === focusRequest) return;
    draft.lastFocusRequest = focusRequest;
    input.current?.focus();
  }, [draft, focusRequest]);
  return (
    <form
      className={styles.comment}
      data-operation={operation}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !blocked && body.trim()) onSubmit(body);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Field label="Comment" labelVisibility="hidden">
        <Textarea
          ref={input}
          rows={3}
          value={body}
          disabled={busy}
          readOnly={blocked}
          onChange={(event) => {
            if (!busy && !blocked) {
              // Retain text through annotation remounts without rerendering the file list.
              draft.body = event.target.value;
              setBody(draft.body);
            }
          }}
        />
      </Field>
      {notice && <p role="status">{notice}</p>}
      <div className={styles.actions}>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="prominent"
          type="submit"
          loading={busy}
          disabled={blocked || !body.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
