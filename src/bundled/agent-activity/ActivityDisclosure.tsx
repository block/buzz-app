import { Accordion } from "@base-ui/react/accordion";
import type { ReactNode } from "react";
import styles from "./ActivityDisclosure.module.css";
import motionStyles from "./ActivityStream.module.css";
import { CaretDownIcon } from "../../shared/design-system/icons";

/** Local one-button activity disclosure using shared styles and Base UI behavior. */
export function ActivityDisclosure({
  label,
  expanded,
  onExpand,
  children,
  keepMounted = false,
}: {
  label: ReactNode;
  expanded: boolean;
  onExpand(value: boolean): void;
  children: ReactNode;
  keepMounted?: boolean;
}) {
  return (
    <Accordion.Root
      data-buzz-ui=""
      className={`buzz-accordion ${motionStyles.motion}`}
      onPointerDownCapture={(event) => {
        event.currentTarget.dataset.motionInput = "pointer";
      }}
      onKeyDownCapture={(event) => {
        event.currentTarget.dataset.motionInput = "keyboard";
      }}
      data-variant="activity"
      keepMounted={keepMounted}
      value={expanded ? ["activity"] : []}
      onValueChange={(value) => onExpand(value.includes("activity"))}
    >
      <Accordion.Item value="activity">
        <Accordion.Header className="buzz-accordion-heading">
          <Accordion.Trigger className="buzz-accordion-trigger text-body-sm">
            <span className={styles.label}>{label}</span>
            <CaretDownIcon size={14} aria-hidden="true" />
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Panel className="buzz-accordion-panel">
          {children}
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion.Root>
  );
}
