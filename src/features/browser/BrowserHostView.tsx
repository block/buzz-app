import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BrowserViewProps } from "./api";
import type {
  BrowserAction,
  BrowserBounds,
  BrowserPlatform,
  BrowserStatus,
} from "./platform";
import type { BrowserSessions } from "./sessions";
import styles from "./BrowserHostView.module.css";

const EMPTY_STATUS: BrowserStatus = {
  url: "",
  title: "",
  loading: false,
  error: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundsFor(element: HTMLElement): BrowserBounds {
  const rectangle = element.getBoundingClientRect();
  const x = Math.max(0, rectangle.left);
  const y = Math.max(0, rectangle.top);
  const right = Math.min(window.innerWidth, rectangle.right);
  const bottom = Math.min(window.innerHeight, rectangle.bottom);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function hostOverlayOpen(): boolean {
  return Boolean(
    document.querySelector(
      'dialog[open], [aria-modal="true"], [role="menu"], [data-popup-open]',
    ),
  );
}

export function BrowserHostView({
  url,
  platform,
  sessions,
  pollInterval = 300,
}: BrowserViewProps & {
  platform: BrowserPlatform;
  sessions: BrowserSessions;
  pollInterval?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const session = useRef<string | undefined>(undefined);
  const editing = useRef(false);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [draft, setDraft] = useState(url);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing.current && status.url) setDraft(status.url);
  }, [status.url]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let disposed = false;
    let attachStarted = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRequested: { bounds: BrowserBounds; visible: boolean } | undefined;
    let desiredPresentation:
      | { bounds: BrowserBounds; visible: boolean }
      | undefined;
    let writingBounds = false;

    const visible = (bounds: BrowserBounds) =>
      document.visibilityState === "visible" &&
      !hostOverlayOpen() &&
      bounds.width > 0 &&
      bounds.height > 0;

    const syncBounds = (force = false) => {
      const sessionId = session.current;
      if (!sessionId || disposed) return;
      const measuredBounds = boundsFor(element);
      const nextVisible = visible(measuredBounds);
      const bounds =
        measuredBounds.width > 0 && measuredBounds.height > 0
          ? measuredBounds
          : lastRequested?.bounds;
      if (!bounds) return;
      if (
        !force &&
        lastRequested?.visible === nextVisible &&
        Object.entries(bounds).every(
          ([key, value]) =>
            lastRequested?.bounds[key as keyof BrowserBounds] === value,
        )
      )
        return;
      lastRequested = { bounds, visible: nextVisible };
      desiredPresentation = lastRequested;
      if (writingBounds) return;
      writingBounds = true;
      void (async () => {
        while (
          !disposed &&
          session.current === sessionId &&
          desiredPresentation
        ) {
          const next = desiredPresentation;
          desiredPresentation = undefined;
          try {
            await platform.setBounds(sessionId, next.bounds, next.visible);
          } catch (error) {
            if (!disposed && session.current === sessionId)
              setLocalError(message(error));
          }
        }
        writingBounds = false;
      })();
    };

    const poll = async () => {
      const sessionId = session.current;
      if (!sessionId || disposed) return;
      try {
        const next = await platform.status(sessionId);
        if (!disposed && session.current === sessionId) setStatus(next);
      } catch (error) {
        if (!disposed && session.current === sessionId)
          setLocalError(message(error));
      } finally {
        if (!disposed && session.current === sessionId)
          pollTimer = setTimeout(poll, pollInterval);
      }
    };

    const begin = () => {
      if (attachStarted || disposed) return;
      const initialBounds = boundsFor(element);
      if (initialBounds.width <= 0 || initialBounds.height <= 0) return;
      attachStarted = true;
      sessions
        .attach(url, initialBounds, () => !disposed)
        .then((sessionId) => {
          if (!sessionId || disposed) return;
          session.current = sessionId;
          syncBounds(true);
          void poll();
        })
        .catch((error) => {
          if (!disposed) {
            setStatus({ ...EMPTY_STATUS, url });
            setLocalError(message(error));
          }
        });
    };

    const updatePresentation = () => {
      begin();
      syncBounds();
    };

    const resizeObserver = new ResizeObserver(updatePresentation);
    resizeObserver.observe(element);
    const mutationObserver = new MutationObserver(updatePresentation);
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "aria-modal", "data-popup-open", "role"],
    });
    const forceBounds = () => syncBounds(true);
    window.addEventListener("resize", forceBounds);
    window.addEventListener("scroll", updatePresentation, true);
    document.addEventListener("visibilitychange", updatePresentation);
    window.visualViewport?.addEventListener("resize", forceBounds);
    window.visualViewport?.addEventListener("scroll", updatePresentation);

    setDraft(url);
    setStatus({ ...EMPTY_STATUS, url, loading: true });
    setLocalError(null);
    begin();

    return () => {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", forceBounds);
      window.removeEventListener("scroll", updatePresentation, true);
      document.removeEventListener("visibilitychange", updatePresentation);
      window.visualViewport?.removeEventListener("resize", forceBounds);
      window.visualViewport?.removeEventListener("scroll", updatePresentation);
      const sessionId = session.current;
      session.current = undefined;
      if (sessionId) void sessions.detach(sessionId);
    };
  }, [platform, pollInterval, sessions, url]);

  async function run(operation: (sessionId: string) => Promise<void>) {
    const sessionId = session.current;
    if (!sessionId) return;
    setLocalError(null);
    try {
      await operation(sessionId);
    } catch (error) {
      if (session.current === sessionId) setLocalError(message(error));
    }
  }

  function navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    editing.current = false;
    void run((sessionId) => platform.navigate(sessionId, draft));
  }

  function action(value: BrowserAction) {
    void run((sessionId) => platform.action(sessionId, value));
  }

  const error = localError ?? status.error;
  return (
    <section className={styles.browser} aria-label="Browser">
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label="Browser controls"
      >
        <button type="button" aria-label="Back" onClick={() => action("back")}>
          ‹
        </button>
        <button
          type="button"
          aria-label="Forward"
          onClick={() => action("forward")}
        >
          ›
        </button>
        <button
          type="button"
          aria-label="Reload"
          onClick={() => action("reload")}
        >
          {status.loading ? "…" : "↻"}
        </button>
        <form onSubmit={navigate}>
          <input
            aria-label="Address"
            value={draft}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
              setDraft(status.url || url);
            }}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        {status.title ? (
          <span className={styles.status} title={status.title}>
            {status.title}
          </span>
        ) : null}
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.viewport} ref={viewport} />
    </section>
  );
}
