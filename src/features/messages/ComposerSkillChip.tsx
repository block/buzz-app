import { useContext, useRef } from "react";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { composerTokenName, type ComposerToken } from "./composer-token";
import { TaskSkillDetailsContext } from "./selected-mention-context";
import styles from "./EditableInput.module.css";

type SkillToken = Extract<ComposerToken, { kind: "nexus.skill" }>;

/** A skill chip opens its details in place: a nested surface, never a visit. */
export function ComposerSkillChip({
  token,
  returnCaret,
}: {
  token: SkillToken;
  /** Puts the editor's caret right after this chip; false if it cannot. */
  returnCaret(): boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  return (
    <PopoverRoot>
      <PopoverTrigger
        ref={trigger}
        className={`${styles.resource} ${styles.skillChip}`}
        aria-label={composerTokenName(token)}
      >
        {token.label}
      </PopoverTrigger>
      <PopoverPopup
        ref={popup}
        // Focus bound for the chip goes on to the text after it. Focus the
        // user moved elsewhere stays there.
        finalFocus={() => {
          const active = trigger.current?.ownerDocument.activeElement;
          const returning =
            !active ||
            active === trigger.current ||
            active === active.ownerDocument.body ||
            !!popup.current?.contains(active);
          return !(returning && returnCaret());
        }}
      >
        <PopoverTitle>{token.label}</PopoverTitle>
        <SkillDetails token={token} />
      </PopoverPopup>
    </PopoverRoot>
  );
}

// Read on open, so the details follow the session's latest report.
function SkillDetails({ token }: { token: SkillToken }) {
  const details = useContext(TaskSkillDetailsContext)?.(token);
  return (
    <>
      {details?.description && (
        <PopoverDescription>{details.description}</PopoverDescription>
      )}
      {details?.location && (
        <p className={`text-body-sm text-secondary ${styles.skillLocation}`}>
          {details.location}
        </p>
      )}
    </>
  );
}
