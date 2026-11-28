import { useSyncExternalStore } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import type { Pages } from "./service";

/** The open plugin quick view, in the same palette frame as search. A body
 * that fails shows nothing and takes nothing else down. */
export function QuickViews({ pages }: { pages: Pick<Pages, "quickViews"> }) {
  const { quickViews } = pages;
  const entry = useSyncExternalStore(quickViews.subscribe, quickViews.open);
  return (
    <Dialog
      open={entry !== undefined}
      onOpenChange={(open) => {
        if (!open) quickViews.close();
      }}
      title={entry?.title ?? ""}
      presentation="search"
      size="wide"
      height="stable-tall"
      bodyLayout="flex"
      footerGap="none"
      dismissOnOutsideClick
    >
      {entry && (
        <OwnedContribution
          key={entry.key}
          entry={entry}
          registry={quickViews}
          fallback={null}
        >
          {({ component: Body }) => <Body close={quickViews.close} />}
        </OwnedContribution>
      )}
    </Dialog>
  );
}
