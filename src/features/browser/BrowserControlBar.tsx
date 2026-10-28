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
import styles from "./BrowserHostView.module.css";

export type BrowserControlRecipient = Readonly<{
  id: string;
  name: string;
  eligible: boolean;
  unavailable: string;
  control: BrowserControl;
}>;

/** The owner picks a recipient; closing the menu never grants access by itself. */
export function BrowserControlBar({
  recipients,
  complete = true,
  sessionId,
  status,
  prepare,
  onError,
}: {
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
  const report = useRef(onError);
  report.current = onError;
  useEffect(
    () => () => {
      generation.current++;
      queued.current = undefined;
      void active.current?.control.revoke(sessionId).catch(() => undefined);
      active.current = undefined;
      report.current(undefined);
    },
    [sessionId],
  );

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
      generation.current++;
      queued.current = undefined;
      active.current = undefined;
      setGrant(undefined);
      setPending(false);
      void current.control.revoke(sessionId).catch(() => undefined);
    }
  }, [recipients, sessionId]);

  async function share(next: BrowserControlRecipient) {
    const current = ++generation.current;
    active.current = next;
    setRecipient(next);
    setPending(true);
    report.current(undefined);
    try {
      await prepare();
      if (generation.current !== current) return;
      const granted = await next.control.grant(sessionId);
      if (generation.current === current) setGrant(granted);
    } catch (failure) {
      if (generation.current === current) report.current(String(failure));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  async function takeControl() {
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
