import { useContext } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  composerHost,
  useComposerForm,
  useComposerScope,
} from "./composer-overlay";
import { DetailsSheet } from "./DetailsSheet";
import { LayerAddressContext, layerInView } from "./view-layer";

/** The panel layer of the view it is mounted in, when the address names one:
 * a full-height sheet over that view's composer, or a centered dialog when
 * the composer isn't on screen. The address owns whether it is open. */
export function PanelLayer({ channelId }: { channelId: string }) {
  const view = useComposerScope();
  const address = useContext(LayerAddressContext);
  const form = useComposerForm(view?.handle);
  const open = address?.open;
  if (!address || !view || !open?.target || !layerInView(open, channelId, view))
    return null;
  const drawn = address.renderPanel(open);
  if (!drawn) return null;
  const host = form ? composerHost(view.handle) : null;
  const onOpenChange = (next: boolean) => {
    if (!next) address.dismiss();
  };
  // Each target is its own reader: a replacement mounts fresh.
  return host ? (
    <DetailsSheet
      key={open.target}
      open
      onOpenChange={onOpenChange}
      host={host}
      title={drawn.title}
      readerOnly
      onOpenAsTab={drawn.openAsTab}
    >
      {drawn.content}
    </DetailsSheet>
  ) : (
    <Dialog
      key={open.target}
      open
      onOpenChange={onOpenChange}
      title={drawn.title}
      size="wide"
      visit
    >
      {drawn.content}
    </Dialog>
  );
}
