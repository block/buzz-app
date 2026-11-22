import { ArrowSquareOutIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import type { BrowserViewProps } from "./api";
import type { BrowserPlatform } from "./platform";

/** Stands in for the website while Settings sends links to the system browser. */
export function ExternalBrowserNotice({
  url,
  platform,
}: BrowserViewProps & { platform: BrowserPlatform }) {
  return (
    <EmptyState
      icon={<ArrowSquareOutIcon />}
      title="Links open in your system browser"
      description="The in-app browser is off in Settings."
      action={
        <Button type="button" onClick={() => void platform.openExternal(url)}>
          Open in browser
        </Button>
      }
    />
  );
}
