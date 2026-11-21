import { useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InfoIcon } from "../../shared/design-system/icons";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { profileTarget } from "../profiles/target";
import { workflowLink, workflowLinks } from "../workflows/route";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowView,
} from "../workflows/types";
import styles from "./Messages.module.css";

/** Mounted only while the card is open, so opening it is the reader's request
 * to look the workflow up and closing it cancels that read. Offers the action
 * only once this session holds a definition the viewer can read. While that is
 * being read the action's line is kept empty, so the open card does not grow;
 * an unknown, failed, deleted or inaccessible workflow leaves the card as it
 * was. */
function ViewWorkflow({
  capability,
  owner,
  id,
  onOpenLink,
}: {
  capability: WorkflowCapability;
  owner: string;
  id: string;
  onOpenLink(url: string): boolean;
}) {
  const store = useMemo(() => {
    let view: WorkflowView<WorkflowDefinition | undefined> | undefined;
    return {
      state() {
        const snapshot = view?.snapshot();
        return snapshot?.status === "loading"
          ? "reading"
          : snapshot?.status === "ready" && snapshot.data
            ? "readable"
            : "none";
      },
      subscribe(listener: () => void) {
        let owned: typeof view;
        try {
          owned = capability.locate({ owner, id });
        } catch {
          return () => {};
        }
        view = owned;
        const stop = owned.subscribe(listener);
        void owned.refresh({ ifStale: true });
        return () => {
          stop();
          owned.dispose();
          if (view === owned) view = undefined;
        };
      },
    };
  }, [capability, owner, id]);
  const state = useSyncExternalStore(
    store.subscribe,
    store.state,
    () => "none" as const,
  );
  const [unopened, setUnopened] = useState(false);
  if (state === "none") return null;
  if (state === "reading")
    return (
      <p
        className={`${styles.workflowAction} ${styles.workflowActionPending} text-body-sm`}
        aria-hidden="true"
      >
        View workflow
      </p>
    );
  return (
    <p className={`${styles.workflowAction} text-body-sm`}>
      <Button
        variant="link"
        size="text"
        onClick={() => setUnopened(!onOpenLink(workflowLink({ owner, id })))}
      >
        View workflow
      </Button>
      {unopened && <span role="status"> Couldn’t open this workflow.</span>}
    </p>
  );
}

export function WorkflowByline({
  ownerId,
  ownerName,
  workflow,
  canOpenLink,
  onOpenLink,
}: {
  ownerId: string;
  ownerName: string;
  /** The session's workflow lookup and the ID the relay named, when both exist. */
  workflow?:
    | Readonly<{ capability: WorkflowCapability; id: string }>
    | undefined;
  canOpenLink?: ((url: string) => boolean) | undefined;
  onOpenLink(url: string): boolean;
}) {
  const target = profileTarget(ownerId);
  // Without a running Workflows page there is nothing to open, so the card
  // neither offers the workflow nor reads it.
  const linked = useSyncExternalStore(
    workflowLinks.subscribe,
    workflowLinks.available,
    () => false,
  );
  return (
    <span className={styles.workflowAttribution}>
      <strong className={styles.author}>Workflow</strong>
      <span className={styles.workflowOwner}>
        <span aria-hidden="true">· </span>owned by{" "}
        {target && canOpenLink?.(target) ? (
          <Button
            variant="link"
            size="inline"
            aria-label={`View workflow owner ${ownerName} profile`}
            onClick={() => onOpenLink(target)}
          >
            {ownerName}
          </Button>
        ) : (
          ownerName
        )}
      </span>
      <PopoverRoot>
        <PopoverTrigger
          openOnHover="preview"
          render={
            <IconButton
              size="xs"
              variant="ghost"
              aria-label="Workflow message details"
              icon={<InfoIcon />}
            />
          }
        />
        <PopoverPopup size="compact">
          <PopoverTitle>Workflow message</PopoverTitle>
          <PopoverDescription>
            Sent automatically by a workflow. Its owner set it up but didn’t
            send this message personally.
          </PopoverDescription>
          {workflow && linked && (
            <ViewWorkflow
              capability={workflow.capability}
              owner={ownerId}
              id={workflow.id}
              onOpenLink={onOpenLink}
            />
          )}
        </PopoverPopup>
      </PopoverRoot>
    </span>
  );
}
