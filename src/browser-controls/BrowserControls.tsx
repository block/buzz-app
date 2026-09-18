import { useEffect, useRef, useState, type FormEvent } from "react";
import { navigateBrowser, performBrowserAction } from "./api";
import { useBrowserStatus } from "./useBrowserStatus";
import styles from "./BrowserControls.module.css";

/**
 * Trusted controls surface only: no app services, auth, or plugin runtime
 * loaded here. The guest page is a separate, untrusted webview this
 * component never touches directly — every action is a native invoke.
 */
export function BrowserControls() {
  const status = useBrowserStatus();
  const [draft, setDraft] = useState(status.url);
  const [localError, setLocalError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(status.url);
  }, [status.url]);

  function reportRejection(error: unknown) {
    setLocalError(error instanceof Error ? error.message : String(error));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    editing.current = false;
    setLocalError(null);
    navigateBrowser(draft).catch(reportRejection);
  }

  function runAction(action: Parameters<typeof performBrowserAction>[0]) {
    setLocalError(null);
    performBrowserAction(action).catch(reportRejection);
  }

  const error = localError ?? status.error;

  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label="Browser controls"
    >
      <button
        type="button"
        className={styles.button}
        aria-label="Back"
        onClick={() => runAction("back")}
      >
        ‹
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Forward"
        onClick={() => runAction("forward")}
      >
        ›
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Reload"
        onClick={() => runAction("reload")}
      >
        {status.loading ? "…" : "↻"}
      </button>
      <form className={styles.form} onSubmit={submit}>
        <input
          className={styles.address}
          type="text"
          aria-label="Address"
          value={draft}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
            setDraft(status.url);
          }}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
      {error ? (
        <span
          className={`${styles.status} ${styles.error}`}
          role="alert"
          title={error}
        >
          {error}
        </span>
      ) : status.title ? (
        <span className={styles.status} title={status.title}>
          {status.title}
        </span>
      ) : null}
    </div>
  );
}
