import { useId, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import styles from "./CreateSidebarSection.module.css";

/** Mounted after the launching menu closes, so focus has one modal owner. */
export function CreateSidebarSection({
  channelName,
  maxLength = 256,
  create,
  close,
}: {
  channelName: string;
  maxLength?: number;
  create: (section: { id: string; name: string }) => void;
  close: () => void;
}) {
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const submitted = useRef(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Create new section"
      description={
        <span className={styles.description}>
          Move <span title={channelName}>{channelName}</span> into a new
          section.
        </span>
      }
      initialFocus={input}
      finalFocus={false}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            form={formId}
            type="submit"
            variant="prominent"
            disabled={!name.trim()}
          >
            Create and move
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (submitted.current || !name.trim()) return;
          submitted.current = true;
          create({ id: crypto.randomUUID(), name: name.trim() });
        }}
      >
        <Input
          ref={input}
          aria-label="Section name"
          placeholder="Section name"
          required
          maxLength={maxLength}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </form>
    </Dialog>
  );
}
