import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckIcon,
  CopyIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { writeClipboardText } from "../../shared/clipboard";
import styles from "./Profiles.module.css";

export function ProfilePublicMetadata({
  nip05,
}: {
  nip05: string | undefined;
}) {
  return nip05 ? (
    <ProfileCopyField
      key={`nip05:${nip05}`}
      label="NIP-05"
      value={nip05}
      copyLabel={`Copy NIP-05: ${nip05}`}
      hint="Copy NIP-05"
    />
  ) : null;
}

const outcomes = {
  copied: { Icon: CheckIcon, text: "Copied" },
  failed: { Icon: WarningCircleIcon, text: "Couldn’t copy" },
};

/** A profile value with its Copy button. The button alone shows the result:
 * a copy reverts after 1.5 seconds, a refused copy stays until the next
 * attempt. The status repeats it for assistive technology. */
export function ProfileCopyField({
  label,
  value,
  copyLabel,
  hint,
  children = <span className="break-all">{value}</span>,
}: {
  label: string;
  value: string;
  /** The button's accessible name, which stays the same in every state. */
  copyLabel: string;
  hint?: string;
  /** How the value is shown, when not as plain text. */
  children?: ReactNode;
}) {
  const [outcome, setOutcome] = useState<keyof typeof outcomes>();
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (outcome !== "copied") return;
    const timer = setTimeout(() => setOutcome(undefined), 1500);
    return () => clearTimeout(timer);
  }, [outcome]);
  const { Icon, text } = outcome
    ? outcomes[outcome]
    : { Icon: CopyIcon, text: "Copy" };
  return (
    <SettingsGroup>
      <PreferenceRow
        title={label}
        subtitle={children}
        trailing={
          <>
            <Button
              size="compact"
              variant="ghost"
              aria-label={copyLabel}
              title={hint}
              onClick={() => {
                const current = ++generation.current;
                const settle = (next: keyof typeof outcomes) => () => {
                  if (current === generation.current) setOutcome(next);
                };
                setOutcome(undefined);
                void Promise.resolve()
                  .then(() => writeClipboardText(value))
                  .then(settle("copied"), settle("failed"));
              }}
            >
              <Icon size={16} aria-hidden="true" />
              <span
                className={styles.copyLabel}
                data-reserve={outcomes.copied.text}
              >
                {text}
              </span>
            </Button>
            <span role="status" className="sr-only">
              {outcome && text}
            </span>
          </>
        }
      />
    </SettingsGroup>
  );
}
