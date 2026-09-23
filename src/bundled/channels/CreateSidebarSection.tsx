import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./CreateSidebarSection.module.css";

/** Mounted after the launching menu closes, so focus has one modal owner. */
export function CreateSidebarSection({
  channelName,
  create,
  close,
}: {
  channelName: string;
  create: (section: { id: string; name: string }) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [name, setName] = useState("");
  const submitted = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const dismiss = () => {
    dialog.current?.close();
    close();
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby={title}
      data-buzz-ui=""
      className={`${styles.dialog} text-body-sm`}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (submitted.current || !name.trim()) return;
          submitted.current = true;
          dialog.current?.close();
          create({ id: crypto.randomUUID(), name: name.trim() });
        }}
      >
        <h2 id={title} className="text-heading">
          Create new section
        </h2>
        <p className={styles.description}>
          Move <span title={channelName}>{channelName}</span> into a new
          section.
        </p>
        <input
          aria-label="Section name"
          placeholder="Section name"
          className={styles.input}
          required
          maxLength={256}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className={styles.actions}>
          <Button onClick={dismiss}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create and move
          </Button>
        </div>
      </form>
    </dialog>
  );
}
