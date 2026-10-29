import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import type {
  BrowserControl,
  BrowserControlGrant,
  BrowserStatus,
} from "./platform";
import type { BrowserInitialShare } from "./control-access";
import styles from "./BrowserHostView.module.css";

export type BrowserControlRecipient = Readonly<{
  id: string;
  name: string;
  eligible: boolean;
  unavailable: string;
  control: BrowserControl;
}>;

/** Uses an owner choice or a one-time host assignment for a newly opened page. */
export function BrowserControlBar({
  recipients,
  initialShare,
  complete = true,
  sessionId,
  status,
  prepare,
  onError,
}: {
  initialShare?: BrowserInitialShare | undefined;
  recipients: readonly BrowserControlRecipient[];
  complete?: boolean;
  sessionId: string;
  status?: BrowserStatus | undefined;
  prepare(): Promise<void>;
  onError(error: string | undefined): void;
}) {
  const [grant, setGrant] = useState<BrowserControlGrant>();
  const [recipient, setRecipient] = useState<BrowserControlRecipient>();
  const active = useRef<BrowserControlRecipient | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const queued = useRef<BrowserControlRecipient | undefined>(undefined);
  const generation = useRef(0);
  const initial = useRef(initialShare);
  const starting = useRef(false);
  const mounted = useRef(false);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current)
          initial.current?.complete(
            new Error("Browser opening was cancelled."),
          );
      });
      generation.current++;
      queued.current = undefined;
      void active.current?.control.revoke(sessionId).catch(() => undefined);
      active.current = undefined;
      report.current(undefined);
    };
  }, [sessionId]);

  useEffect(() => {
    if (
      grant &&
      !pending &&
      (status?.control_revision ?? -1) >= grant.revision &&
      !status?.control_granted
    ) {
      setGrant(undefined);
      void active.current?.control.revoke(sessionId).catch(() => undefined);
    }
  }, [grant, pending, status, sessionId]);

  useEffect(() => {
    const current = active.current;
    if (
      current &&
      !recipients.some((item) => item.id === current.id && item.eligible)
    ) {
      initial.current?.complete(new Error("Browser opening was cancelled."));
      generation.current++;
      queued.current = undefined;
      active.current = undefined;
      setGrant(undefined);
      setPending(false);
      void current.control.revoke(sessionId).catch(() => undefined);
    }
  }, [recipients, sessionId]);

  useEffect(() => {
    const request = initial.current;
    const next = recipients.find(
      (item) => item.id === request?.agent && item.eligible,
    );
    if (request && !starting.current && status?.error) {
      request.complete(new Error(status.error));
      return;
    }
    let current = true;
    // Wait until StrictMode's mount probe has finished before consuming the request.
    queueMicrotask(() => {
      if (
        current &&
        !status?.loading &&
        !starting.current &&
        request &&
        next &&
        request.claim()
      ) {
        starting.current = true;
        void share(next, request);
      }
    });
    return () => {
      current = false;
    };
  });

  async function share(
    next: BrowserControlRecipient,
    opening?: BrowserInitialShare,
  ) {
    if (!opening && initial.current) {
      starting.current = true;
      initial.current.complete(
        new Error("Browser opening was cancelled by a manual sharing choice."),
      );
      initial.current = undefined;
    }
    const current = ++generation.current;
    active.current = next;
    setRecipient(next);
    setPending(true);
    report.current(undefined);
    try {
      await prepare();
      if (opening) {
        if (!opening.valid()) throw new Error("Browser opening was cancelled.");
        await opening.prepare();
      }
      if (generation.current !== current)
        throw new Error("Browser opening was cancelled.");
      if (opening && !opening.valid())
        throw new Error("Browser opening was cancelled.");
      const granted = await next.control.grant(sessionId);
      if (opening && !opening.valid()) {
        await next.control.revoke(sessionId);
        throw new Error("Browser opening was cancelled.");
      }
      if (generation.current !== current)
        throw new Error("Browser opening was cancelled.");
      setGrant(granted);
      opening?.complete();
    } catch (failure) {
      opening?.complete(failure);
      if (generation.current === current) report.current(String(failure));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  async function takeControl() {
    initial.current?.complete(new Error("Browser opening was cancelled."));
    const current = ++generation.current;
    queued.current = undefined;
    setPending(true);
    report.current(undefined);
    try {
      await active.current?.control.revoke(sessionId);
      if (generation.current === current) setGrant(undefined);
    } catch (failure) {
      if (generation.current === current) report.current(String(failure));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  const eligible = recipients.filter((item) => item.eligible);
  const direct = complete && eligible.length === 1 ? eligible[0] : undefined;
  const unavailable =
    recipients[0]?.unavailable ||
    "Add a local agent to this conversation to share the browser.";
  return (
    <MenuRoot
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const chosen = queued.current;
        queued.current = undefined;
        if (
          chosen &&
          recipients.some((item) => item.id === chosen.id && item.eligible)
        )
          void share(chosen);
      }}
    >
      <div className={styles.control} data-browser-control="">
        {grant && recipient ? (
          <Button
            size="sm"
            variant="ghost"
            shape="control"
            aria-label={`Take control from ${recipient.name}`}
            title={`${recipient.name} can read and interact with this browser. Click to take control.`}
            onClick={() => void takeControl()}
          >
            <span className={styles.controlContent} role="status">
              <span className={styles.controlName}>{recipient.name}</span>
              <span className={styles.controlAction}>
                <span className={styles.controlSeparator}> · </span>Take control
              </span>
            </span>
          </Button>
        ) : pending ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              shape="control"
              loading
              aria-label="Sharing browser"
            >
              <span className={styles.controlName}>Sharing…</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              shape="control"
              onClick={() => void takeControl()}
            >
              Take control
            </Button>
          </>
        ) : !menuOpen && (direct || !eligible.length) ? (
          <Button
            size="sm"
            variant="ghost"
            shape="control"
            aria-label={direct ? `Share with ${direct.name}` : "Share browser"}
            title={
              direct
                ? `Let ${direct.name} read and use this browser in this conversation`
                : unavailable
            }
            disabled={!direct}
            focusableWhenDisabled
            onClick={() => {
              if (direct) void share(direct);
            }}
          >
            <span className={styles.controlContent}>
              <span className={styles.controlAction}>
                Share
                <span className={styles.controlName}>
                  {direct ? " with " : ""}
                </span>
              </span>
              {direct ? (
                <span className={styles.controlName}>{direct.name}</span>
              ) : null}
            </span>
          </Button>
        ) : (
          <MenuTrigger
            render={
              <Button size="sm" variant="ghost" shape="control">
                Share…
              </Button>
            }
          />
        )}
      </div>
      <MenuPopup align="end" size="compact">
        <MenuGroup>
          <MenuGroupLabel>Share browser with</MenuGroupLabel>
          {recipients.map((item) => (
            <MenuItem
              key={item.id}
              disabled={!item.eligible}
              title={item.eligible ? undefined : item.unavailable}
              onClick={() => {
                queued.current = item;
                setMenuOpen(false);
              }}
            >
              {item.name}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </MenuRoot>
  );
}
