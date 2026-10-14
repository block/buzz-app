import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useReducedMotion } from "motion/react";
import type { Agent, Agents } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AgentCreateHeader } from "./AgentCreateHeader";
import styles from "./AgentCreate.module.css";

/** Identity edits share creation's avatar picker, but only publish on Save. */
export function AgentIdentityDialog({
  agent,
  agents,
  onClose,
  finalFocus,
  initialAvatarPicker = false,
}: {
  agent: Agent;
  agents: Agents;
  onClose(): void;
  finalFocus: RefObject<HTMLButtonElement | null>;
  initialAvatarPicker?: boolean;
}) {
  const [name, setName] = useState(agent.name);
  const [picture, setPicture] = useState(agent.picture ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarActive, setAvatarActive] = useState(initialAvatarPicker);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarAction, setAvatarAction] = useState<HTMLDivElement | null>(null);
  const avatarNavigation = useRef<{ back(): void }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const form = useId();
  const formElement = useRef<HTMLFormElement>(null);
  const resize = useRef<Animation | null>(null);
  const resizeFrom = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const changeAvatarView = useCallback((active: boolean) => {
    if (resize.current?.playState === "running") {
      const popup =
        formElement.current?.closest<HTMLElement>('[role="dialog"]');
      resizeFrom.current = popup?.getBoundingClientRect().height ?? null;
    }
    setAvatarActive(active);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Measure the modal after each avatar view changes its layout.
  useLayoutEffect(() => {
    const popup = formElement.current?.closest<HTMLElement>('[role="dialog"]');
    const from = resizeFrom.current;
    resize.current?.cancel();
    const to = popup?.getBoundingClientRect().height ?? null;
    resizeFrom.current = to;
    if (
      !popup ||
      from === null ||
      to === null ||
      reducedMotion ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
    )
      return;
    if (from === to) return;
    // Animate the frame itself so text and avatar artwork never stretch.
    resize.current = popup.animate(
      { height: [`${from}px`, `${to}px`] },
      { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    return () => resize.current?.cancel();
  }, [avatarActive, reducedMotion]);
  const back = avatarActive
    ? () => avatarNavigation.current?.back()
    : undefined;
  const save = async () => {
    if (pending || avatarBusy || avatarActive || !name.trim()) return;
    setPending(true);
    setError("");
    try {
      await agents.save(agent.pubkey, {
        name: name.trim(),
        picture: picture || null,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title="Edit agent"
      size="wide"
      height={avatarActive ? "stable-tall" : "content"}
      chromeSpacing="padded"
      bodyLayout={avatarActive ? "flex" : "flow"}
      initialFocus={initialAvatarPicker ? undefined : nameField}
      finalFocus={finalFocus}
      preventClose={pending || avatarBusy}
      dismissOnOutsideClick={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onEscape={() => {
        if (back) {
          back();
          return true;
        }
        return pending || avatarBusy;
      }}
      leadingActions={
        back && (
          <Button disabled={pending || avatarBusy} onClick={back}>
            Back
          </Button>
        )
      }
      actions={
        <>
          <div ref={setAvatarAction} hidden={!avatarActive} />
          {!avatarActive && (
            <>
              <Button disabled={pending || avatarBusy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                form={form}
                loading={pending}
                disabled={pending || avatarBusy || !name.trim()}
              >
                Save changes
              </Button>
            </>
          )}
        </>
      }
    >
      <form
        id={form}
        ref={formElement}
        className={`${styles.form} ${styles.identityEditForm}`}
        data-avatar-active={avatarActive || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <AgentCreateHeader
          initialAvatarPicker={initialAvatarPicker}
          name={name}
          picture={picture}
          community={agent.relay}
          disabled={pending}
          onBusyChange={setAvatarBusy}
          onChange={(patch) => {
            if (patch.name !== undefined) setName(patch.name);
            if (patch.picture !== undefined) setPicture(patch.picture);
            setError("");
          }}
          nameRef={nameField}
          details={null}
          editing={false}
          avatarNavigationRef={avatarNavigation}
          avatarActionTarget={avatarAction}
          onAvatarActiveChange={changeAvatarView}
        />
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
