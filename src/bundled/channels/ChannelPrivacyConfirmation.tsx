import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { readView, writeView } from "../../shared/view-state";

type Visibility = "private" | "public";
const preferenceKey = (visibility: Visibility) =>
  `channel-privacy-confirmation:${visibility}:dismissed`;

// View intent only: shared by Create/Edit, never authorization to publish.
export function skipPrivacyConfirmation(scope: string, visibility: Visibility) {
  return readView<unknown>(scope, preferenceKey(visibility), false) === true;
}

export function rememberPrivacyConfirmation(
  scope: string,
  visibility: Visibility,
) {
  writeView(scope, preferenceKey(visibility), true);
}

export function ChannelPrivacyConfirmation({
  visibility,
  checked,
  onCheckedChange,
}: {
  visibility: Visibility;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <BaseDialog.Description>
        {visibility === "private"
          ? "Only channel members will have access."
          : "Everyone in this community will be able to view this channel’s full history."}
      </BaseDialog.Description>
      <Checkbox
        label="Don’t show me this again"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
