import type { ReactNode } from "react";
import { CopyIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { writeClipboardText } from "../../shared/clipboard";
import {
  CopyLabel,
  CopyStatus,
  useCopyFeedback,
} from "../../shared/CopyFeedback";

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
  const { copied, failed, copy } = useCopyFeedback({ reportsRefusal: true });
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
              onClick={() => void copy(() => writeClipboardText(value))}
            >
              <CopyLabel
                label="Copy"
                icon={<CopyIcon size={16} aria-hidden="true" />}
                copied={copied}
                failed={failed}
              />
            </Button>
            <CopyStatus copied={copied} failed={failed} />
          </>
        }
      />
    </SettingsGroup>
  );
}
