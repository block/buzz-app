import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  PanelProps,
  ChannelPanelContext,
} from "../../features/panels/service";
import type { TerminalSessions } from "./sessions";
import styles from "./Terminal.module.css";

export function TerminalPanel({
  channelContext,
  close,
  sessions,
}: PanelProps & { sessions: TerminalSessions }) {
  if (!channelContext) throw new Error("Terminal requires a channel context");
  return <Content context={channelContext} close={close} sessions={sessions} />;
}
function Content({
  context,
  close,
  sessions,
}: {
  context: ChannelPanelContext;
  close(): void;
  sessions: TerminalSessions;
}) {
  const version = useSyncExternalStore(
    sessions.subscribe,
    sessions.snapshot,
    sessions.snapshot,
  );
  const entry = sessions.get(context);
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    try {
      sessions.ensure(context);
    } catch (error) {
      setError(String(error));
    }
  }, [context, sessions]);
  useEffect(() => {
    if (entry?.screen && host.current) return entry.screen.mount(host.current);
  }, [entry?.screen]);
  const end = async (restart: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await sessions.end(context);
      if (restart && mounted.current) sessions.ensure(context);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className={styles.panel} data-terminal-version={version}>
      <header className={styles.toolbar}>
        <strong>BuzzTerm</strong>
        <span title={entry?.context.channelId ?? context.channelId}>
          #{entry?.context.channelName ?? context.channelName}
        </span>
        {entry?.context.threadId && (
          <span title={entry.context.threadId}>
            Thread {entry.context.threadId.slice(0, 8)}
          </span>
        )}
        <span className={styles.status}>
          {entry?.status ?? (sessions.available ? "ended" : "desktop only")}
        </span>
        {sessions.available && (
          <button type="button" disabled={busy} onClick={() => void end(true)}>
            {entry ? "Restart" : "Start session"}
          </button>
        )}
        {entry && (
          <button type="button" disabled={busy} onClick={() => void end(false)}>
            End session
          </button>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Hide terminal"
          title="Hide terminal (Cmd/Ctrl+J)"
        >
          Hide
        </button>
      </header>
      {!sessions.available ? (
        <p className={styles.notice}>
          Open Buzz Desktop to use your local shell. The browser cannot start a
          terminal on your computer.
        </p>
      ) : (
        <>
          {(error || entry?.error) && (
            <p className={styles.notice} role="alert">
              {error ?? entry?.error}
            </p>
          )}
          {entry?.status === "starting" && (
            <p className={styles.notice} role="status">
              Starting your login shell…
            </p>
          )}
          {!entry && (
            <p className={styles.notice}>
              Session ended. Start a new shell to use this channel’s current
              context.
            </p>
          )}
          <div className={styles.screen} ref={host} />
        </>
      )}
    </div>
  );
}
